import { sourceBitsPerPixel } from "./model";
import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample, type Track } from "mp4box";

/**
 * Reads an MP4/MOV (ISO BMFF) file's tracks and sample tables with mp4box.js,
 * plus the decoder configurations WebCodecs needs.
 *
 * Only the index (`moov`) is parsed, in small reads that skip over the media
 * data, wherever in the file it is (iPhone .MOV files put it at the end). The
 * samples' bytes stay in the file and are read on demand (`SampleReader`), so
 * a 1 GB 4K iPhone clip costs a few megabytes of memory, not two copies of
 * itself. Fragmented files (no sample table in `moov`) are read whole instead.
 */

/** Where a sample is in the file and when it plays. `data` is set only for files read whole. */
export type SampleInfo = {
  readonly offset: number;
  readonly size: number;
  readonly cts: number;
  readonly dts: number;
  readonly duration: number;
  readonly is_sync: boolean;
  readonly data?: Uint8Array;
};

export type DemuxedVideo = {
  readonly track: Track;
  /** The file the samples are read from. */
  readonly file: Blob;
  readonly samples: readonly SampleInfo[];
  readonly config: VideoDecoderConfig;
  /** Clockwise rotation from the track matrix (phones record sideways and flag it). */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly fps: number;
  /** Bits per pixel per frame of the original encoding (drives "Maximum" export quality). */
  readonly bitsPerPixel: number;
  /** Colour description stated by the file, if any (needed to copy VP9/AV1 losslessly). */
  readonly colorSpace?: VideoColorSpaceInit;
};

export type DemuxedAudio = {
  readonly track: Track;
  readonly file: Blob;
  readonly samples: readonly SampleInfo[];
  /** Seconds the edit list skips at the start (the AAC encoder's priming samples). */
  readonly skip: number;
  readonly codec: "aac" | "opus";
  readonly config: AudioDecoderConfig;
};

export type Demuxed = {
  readonly duration: number;
  readonly video: DemuxedVideo;
  readonly audio: DemuxedAudio | null;
  /** Why an audio track that exists cannot be kept, if so. */
  readonly audioNote: string | null;
};

type HvcC = {
  write(s: DataStream): void;
  general_profile_space: number;
  general_tier_flag: number;
  general_profile_idc: number;
  general_profile_compatibility: number;
  general_constraint_indicator: ArrayLike<number>;
  general_level_idc: number;
};

type Entry = {
  avcC?: { write(s: DataStream): void };
  hvcC?: HvcC;
  vpcC?: { write(s: DataStream): void; colourPrimaries?: number; transferCharacteristics?: number; matrixCoefficients?: number; videoFullRangeFlag?: number };
  colr?: { colour_type?: string; colour_primaries?: number; transfer_characteristics?: number; matrix_coefficients?: number; full_range_flag?: number };
  av1C?: { write(s: DataStream): void };
  esds?: Esds;
  /** QuickTime (.MOV) sound descriptions keep the esds inside a `wave` box. */
  wave?: { esds?: Esds };
  dOps?: { OutputChannelCount: number; PreSkip: number; InputSampleRate: number; OutputGain: number };
};

type Esds = { esd?: { descs?: { descs?: { data?: Uint8Array }[] }[] } };

/**
 * The AAC AudioSpecificConfig of an mp4a sample entry: from its esds, or, in QuickTime
 * files (iPhone .MOV), from the esds inside its `wave` box. Without it no decoder,
 * ADTS stream or muxer can describe the audio, and the clip plays silent.
 */
export function audioSpecificConfig(entry: Pick<Entry, "esds" | "wave"> | undefined): Uint8Array | undefined {
  const esds = entry?.esds ?? entry?.wave?.esds;
  return esds?.esd?.descs?.[0]?.descs?.[0]?.data;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The sample rate an AudioSpecificConfig names (QuickTime v2 headers carry a placeholder). */
export function ascSampleRate(asc: Uint8Array | undefined): number | null {
  if (!asc || asc.length < 2) return null;
  const index = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  if (index === 15 && asc.length >= 5) return ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
  return AAC_RATES[index] ?? null;
}

/** The channel count an AudioSpecificConfig names (0: given elsewhere). */
const ascChannels = (asc: Uint8Array | undefined) => (asc && asc.length >= 2 ? (asc[1] >> 3) & 15 : 0);

function sampleEntry(file: ReturnType<typeof createFile>, track: Track): Entry | undefined {
  const trak = file.getTrackById(track.id) as unknown as { mdia: { minf: { stbl: { stsd: { entries: Entry[] } } } } };
  return trak.mdia.minf.stbl.stsd.entries[0];
}

// ISO/IEC 23091-2 code points → WebCodecs names (unlisted ones stay unknown).
const PRIMARIES: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 12: "smpte432" };
const TRANSFER: Record<number, string> = { 1: "bt709", 6: "smpte170m", 8: "linear", 13: "iec61966-2-1", 16: "pq", 18: "hlg" };
const MATRIX: Record<number, string> = { 0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" };

/** The track's colour description (from vpcC, or an nclx colr box), when it states one. */
function colorSpaceOf(entry: Entry | undefined): VideoColorSpaceInit | undefined {
  const v = entry?.vpcC;
  const c = entry?.colr?.colour_type === "nclx" ? entry.colr : undefined;
  // Code 2 means "unspecified" (mp4-muxer always writes it into vpcC and states the colours in colr).
  const pick = (a: number | undefined, b: number | undefined) => (a !== undefined && a !== 2 ? a : b);
  const primaries = pick(v?.colourPrimaries, c?.colour_primaries);
  const transfer = pick(v?.transferCharacteristics, c?.transfer_characteristics);
  const matrix = pick(v?.matrixCoefficients, c?.matrix_coefficients);
  const full = c?.full_range_flag ?? v?.videoFullRangeFlag;
  if (primaries === undefined || !PRIMARIES[primaries] || !TRANSFER[transfer ?? -1] || !MATRIX[matrix ?? -1]) return undefined;
  return { primaries: PRIMARIES[primaries], transfer: TRANSFER[transfer!], matrix: MATRIX[matrix!], fullRange: !!full } as VideoColorSpaceInit;
}

/** The codec configuration box (avcC, hvcC, vpcC, av1C) without its 8-byte header. */
function videoDescription(entry: Entry | undefined): Uint8Array | undefined {
  const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8);
}

function rotationOf(track: Track): DemuxedVideo["rotation"] {
  const m = track.matrix as unknown as ArrayLike<number>;
  if (!m || m.length < 5) return 0;
  // 16.16 fixed point [a b u / c d v / x y w]; the angle of (a, b).
  const deg = Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI);
  const r = (((deg % 360) + 360) % 360) as number;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** Opus decoder description (an "OpusHead" packet) rebuilt from the dOps box. */
function opusHead(d: NonNullable<Entry["dOps"]>): Uint8Array {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, d.OutputChannelCount);
  view.setUint16(10, d.PreSkip, true);
  view.setUint32(12, d.InputSampleRate, true);
  view.setInt16(16, d.OutputGain, true);
  view.setUint8(18, 0);
  return head;
}

/**
 * The HEVC codec string (ISO/IEC 14496-15 annex E) from an hvcC box. Dolby Vision
 * tracks from iPhones ("dvh1"/"dvhe") carry an ordinary HEVC base layer: decoding it
 * as "hvc1" plays them (as HLG/SDR) where Dolby Vision itself is not supported.
 */
export function hevcCodec(h: Omit<HvcC, "write">, prefix = "hvc1"): string {
  let reversed = 0;
  let v = h.general_profile_compatibility >>> 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed << 1) | (v & 1);
    v >>>= 1;
  }
  let constraints = "";
  let any = false;
  for (let i = 5; i >= 0; i--)
    if (h.general_constraint_indicator[i] || any) {
      constraints = `.${h.general_constraint_indicator[i].toString(16).toUpperCase()}${constraints}`;
      any = true;
    }
  const space = ["", "A", "B", "C"][h.general_profile_space] ?? "";
  return `${prefix}.${space}${h.general_profile_idc}.${(reversed >>> 0).toString(16).toUpperCase()}.${h.general_tier_flag ? "H" : "L"}${h.general_level_idc}${constraints}`;
}

/** Seconds of media the track's edit list starts after (0 without one). */
function editSkip(file: ReturnType<typeof createFile>, track: Track): number {
  const trak = file.getTrackById(track.id) as unknown as { edts?: { elst?: { entries?: { media_time: number }[] } }; mdia?: { mdhd?: { timescale: number } } };
  const first = trak.edts?.elst?.entries?.find((e) => e.media_time >= 0);
  const scale = trak.mdia?.mdhd?.timescale || track.timescale;
  return first && scale ? first.media_time / scale : 0;
}

/** Audio codecs the editor can decode and carry over. */
const usableAudio = (codec: string) => codec.startsWith("mp4a.40") || codec === "Opus" || codec === "opus";

const info = (s: Sample): SampleInfo => ({ offset: s.offset, size: s.size, cts: s.cts, dts: s.dts, duration: s.duration, is_sync: s.is_sync, ...(s.data ? { data: s.data } : {}) });

type Movie = Parameters<NonNullable<ReturnType<typeof createFile>["onReady"]>>[0];

/** Reads just the index, skipping the media data. Null for fragmented files (sample tables in `moof`s). */
async function readIndex(file: Blob, chunk: number): Promise<{ mp4: ReturnType<typeof createFile>; movie: Movie } | null> {
  const mp4 = createFile();
  let movie: Movie | null = null;
  let error: string | null = null;
  mp4.onError = (e: string) => {
    error = e;
  };
  mp4.onReady = (i) => {
    movie = i;
  };
  const CHUNK = chunk;
  let pos = 0;
  for (let reads = 0; !movie && pos < file.size && reads < 4096; reads++) {
    const end = Math.min(file.size, pos + CHUNK);
    const ab = await file.slice(pos, end).arrayBuffer();
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos), end >= file.size);
    if (error) throw new Error(`Could not read this video: ${error}`);
    // mp4box says where it wants to read next: past a media data box, it jumps over it.
    pos = typeof next === "number" && next > pos ? next : end;
  }
  if (!movie) return null;
  const m = movie as Movie;
  if (m.isFragmented || !m.videoTracks.length || !mp4.getTrackSamplesInfo(m.videoTracks[0].id)?.length) return null;
  return { mp4, movie: m };
}

/** Whole-file parse with sample extraction (fragmented MP4s). */
function readWhole(buffer: ArrayBuffer): { mp4: ReturnType<typeof createFile>; movie: Movie; samples: Map<number, Sample[]> } {
  const mp4 = createFile(true);
  let movie: Movie | null = null;
  let error: string | null = null;
  const samples = new Map<number, Sample[]>();
  mp4.onError = (e: string) => {
    error = e;
  };
  mp4.onReady = (i) => {
    movie = i;
    for (const t of [...i.videoTracks.slice(0, 1), ...i.audioTracks]) {
      samples.set(t.id, []);
      mp4.setExtractionOptions(t.id, undefined, { nbSamples: 5000 });
    }
    mp4.start();
  };
  mp4.onSamples = (id, _user, list) => {
    samples.get(id)?.push(...list);
  };
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0), true);
  mp4.flush();
  if (error) throw new Error(`Could not read this video: ${error}`);
  if (!movie) throw new Error("Could not read this video (not an MP4/MOV file, or it is damaged).");
  return { mp4, movie, samples };
}

/** `readSize`: bytes per read while looking for the index (tests use small reads). */
export async function demux(file: Blob, readSize = 1 << 20): Promise<Demuxed> {
  const indexed = await readIndex(file, readSize);
  const whole = indexed ? null : readWhole(await file.arrayBuffer());
  const mp4 = indexed?.mp4 ?? whole!.mp4;
  const movie = indexed?.movie ?? whole!.movie;
  const samplesOf = (t: Track): SampleInfo[] => (indexed ? (mp4.getTrackSamplesInfo(t.id) ?? []).map(info) : (whole!.samples.get(t.id) ?? []).map(info));
  const vt = movie.videoTracks[0];
  if (!vt) throw new Error("This file has no video track.");
  const vSamples = samplesOf(vt);
  if (!vSamples.length) throw new Error("This video has no frames.");
  const entry = sampleEntry(mp4, vt);
  const width = vt.video?.width ?? vt.track_width;
  const height = vt.video?.height ?? vt.track_height;
  let codec = vt.codec.startsWith("vp08") ? "vp8" : vt.codec;
  if (/^dv(h1|he)/.test(codec) && entry?.hvcC) codec = hevcCodec(entry.hvcC);
  const config: VideoDecoderConfig = { codec, codedWidth: width, codedHeight: height, description: videoDescription(entry) };
  const seconds = vt.duration / vt.timescale || vSamples.length / 30;
  const fps = Math.max(1, Math.min(240, Math.round((vSamples.length / seconds) * 100) / 100));
  const bitsPerPixel = sourceBitsPerPixel(vSamples.reduce((n, s) => n + s.size, 0), seconds, width, height, fps);

  let audio: DemuxedAudio | null = null;
  let audioNote: string | null = null;
  // Newer iPhones add a spatial audio track (APAC) beside the stereo AAC one: use the first track we can decode.
  const at = movie.audioTracks.find((t) => usableAudio(t.codec));
  if (at) {
    const aEntry = sampleEntry(mp4, at);
    const aSamples = samplesOf(at);
    let channels = at.audio?.channel_count ?? 2;
    let sampleRate = at.audio?.sample_rate ?? 48000;
    if (at.codec.startsWith("mp4a.40")) {
      const asc = audioSpecificConfig(aEntry);
      // The AAC config is the authority (QuickTime headers may say 1 Hz or 0 channels).
      sampleRate = ascSampleRate(asc) ?? (sampleRate >= 8000 ? sampleRate : 48000);
      channels = ascChannels(asc) || channels || 2;
      audio = { track: at, file, samples: aSamples, skip: editSkip(mp4, at), codec: "aac", config: { codec: at.codec, numberOfChannels: channels, sampleRate, description: asc } };
    } else {
      audio = {
        track: at,
        file,
        samples: aSamples,
        skip: editSkip(mp4, at),
        codec: "opus",
        config: { codec: "opus", numberOfChannels: channels, sampleRate, description: aEntry?.dOps ? opusHead(aEntry.dOps) : undefined },
      };
    }
  } else if (movie.audioTracks.length) {
    audioNote = `The ${movie.audioTracks[0].codec} audio track can't be carried over; the export will be silent.`;
  }
  return {
    duration: movie.duration / movie.timescale || seconds,
    video: { track: vt, file, samples: vSamples, config, rotation: rotationOf(vt), fps, bitsPerPixel, colorSpace: colorSpaceOf(entry) },
    audio,
    audioNote,
  };
}

/**
 * Reads samples' bytes from the file through a sliding window, so frames that
 * follow each other on disk cost one read. Each consumer (a decoder, an export)
 * has its own reader. Returned arrays may share the window: copy to keep them.
 */
export class SampleReader {
  private start = 0;
  private bytes: Uint8Array | null = null;

  constructor(
    private readonly file: Blob,
    private readonly window = 4 << 20,
  ) {}

  async read(s: SampleInfo): Promise<Uint8Array> {
    if (s.data) return s.data;
    const b = this.bytes;
    if (b && s.offset >= this.start && s.offset + s.size <= this.start + b.length) return b.subarray(s.offset - this.start, s.offset - this.start + s.size);
    const len = Math.max(this.window, s.size);
    this.bytes = new Uint8Array(await this.file.slice(s.offset, Math.min(this.file.size, s.offset + len)).arrayBuffer());
    this.start = s.offset;
    if (this.bytes.length < s.size) throw new Error("The video file ends before this frame: it may be damaged or still copying.");
    return this.bytes.subarray(0, s.size);
  }
}
