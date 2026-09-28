import { createFile, DataStream, Endianness, MP4BoxBuffer, type Sample, type Track } from "mp4box";

/**
 * Reads an MP4/MOV (ISO BMFF) file into its tracks and samples with mp4box.js,
 * plus the decoder configurations WebCodecs needs. The whole file is parsed in
 * memory, which is fine for phone and camera clips of a few hundred megabytes.
 */
export type DemuxedVideo = {
  readonly track: Track;
  readonly samples: readonly Sample[];
  readonly config: VideoDecoderConfig;
  /** Clockwise rotation from the track matrix (phones record sideways and flag it). */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly fps: number;
};

export type DemuxedAudio = {
  readonly track: Track;
  readonly samples: readonly Sample[];
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

type Entry = {
  avcC?: { write(s: DataStream): void };
  hvcC?: { write(s: DataStream): void };
  vpcC?: { write(s: DataStream): void };
  av1C?: { write(s: DataStream): void };
  esds?: { esd?: { descs?: { descs?: { data?: Uint8Array }[] }[] } };
  dOps?: { OutputChannelCount: number; PreSkip: number; InputSampleRate: number; OutputGain: number };
};

function sampleEntry(file: ReturnType<typeof createFile>, track: Track): Entry | undefined {
  const trak = file.getTrackById(track.id) as unknown as { mdia: { minf: { stbl: { stsd: { entries: Entry[] } } } } };
  return trak.mdia.minf.stbl.stsd.entries[0];
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

export async function demux(file: Blob): Promise<Demuxed> {
  const buffer = await file.arrayBuffer();
  const mp4 = createFile();
  let info: Parameters<NonNullable<typeof mp4.onReady>>[0] | null = null;
  let error: string | null = null;
  const samples = new Map<number, Sample[]>();
  mp4.onError = (e: string) => {
    error = e;
  };
  mp4.onReady = (i) => {
    info = i;
    for (const t of [...i.videoTracks.slice(0, 1), ...i.audioTracks.slice(0, 1)]) {
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
  const movie = info as Parameters<NonNullable<typeof mp4.onReady>>[0] | null;
  if (!movie) throw new Error("Could not read this video (not an MP4/MOV file, or it is damaged).");
  const vt = movie.videoTracks[0];
  if (!vt) throw new Error("This file has no video track.");
  const vSamples = samples.get(vt.id) ?? [];
  if (!vSamples.length) throw new Error("This video has no frames.");
  const entry = sampleEntry(mp4, vt);
  const width = vt.video?.width ?? vt.track_width;
  const height = vt.video?.height ?? vt.track_height;
  const config: VideoDecoderConfig = { codec: vt.codec.startsWith("vp08") ? "vp8" : vt.codec, codedWidth: width, codedHeight: height, description: videoDescription(entry) };
  const seconds = vt.duration / vt.timescale || vSamples.length / 30;
  const fps = Math.max(1, Math.min(240, Math.round((vSamples.length / seconds) * 100) / 100));

  let audio: DemuxedAudio | null = null;
  let audioNote: string | null = null;
  const at = movie.audioTracks[0];
  if (at) {
    const aEntry = sampleEntry(mp4, at);
    const aSamples = samples.get(at.id) ?? [];
    const channels = at.audio?.channel_count ?? 2;
    const sampleRate = at.audio?.sample_rate ?? 48000;
    if (at.codec.startsWith("mp4a.40")) {
      const asc = aEntry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
      audio = { track: at, samples: aSamples, codec: "aac", config: { codec: at.codec, numberOfChannels: channels, sampleRate, description: asc } };
    } else if (at.codec === "Opus" || at.codec === "opus") {
      audio = {
        track: at,
        samples: aSamples,
        codec: "opus",
        config: { codec: "opus", numberOfChannels: channels, sampleRate, description: aEntry?.dOps ? opusHead(aEntry.dOps) : undefined },
      };
    } else {
      audioNote = `The ${at.codec} audio track can't be carried over; the export will be silent.`;
    }
  }
  return { duration: movie.duration / movie.timescale || seconds, video: { track: vt, samples: vSamples, config, rotation: rotationOf(vt), fps }, audio, audioNote };
}
