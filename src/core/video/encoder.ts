export type Mux = "avc" | "hevc" | "vp9" | "av1";

/** A configured encoder choice: constant quality (a per-frame quantizer) when the browser supports it, else a target bitrate. */
export type EncoderChoice = { readonly config: VideoEncoderConfig; readonly mux: Mux; readonly quantizer: number | null };

/**
 * Quality 0..1 → the codec's quantizer (lower is better). H.264/HEVC use
 * 0–51, VP9/AV1 0–63. Quality 1 (Maximum) is near lossless: H.264 QP 8,
 * VP9/AV1 q 4.
 */
export function quantizerFor(mux: Mux, quality: number): number {
  const q = Math.min(1, Math.max(0, quality));
  return mux === "avc" || mux === "hevc" ? Math.round(36 - 28 * q) : Math.round(56 - 52 * q);
}

/** Per-frame encode options for a choice (the quantizer, in constant-quality mode). */
export function encodeOptions(choice: EncoderChoice, keyFrame: boolean): VideoEncoderEncodeOptions {
  if (choice.quantizer === null) return { keyFrame };
  return { keyFrame, [choice.mux]: { quantizer: choice.quantizer } } as VideoEncoderEncodeOptions;
}

/**
 * The first encoder this browser supports, best compatibility first (H.264
 * plays everywhere). With `quality` (0..1), each codec is first tried in
 * constant-quality mode: bitrate-driven encoders drop frames and smear detail
 * when a clip (or an effect such as dithering or grain) needs more bits than
 * the target. Otherwise, or when that mode is missing, the target bitrate is
 * used; hardware encoders can refuse very high bitrates, so it steps down
 * before the codec changes.
 */
export async function chooseEncoder(width: number, height: number, bitrate: number, framerate: number, quality: number | null = null): Promise<EncoderChoice> {
  for (const c of candidates(width, height, bitrate)) {
    const base: VideoEncoderConfig = { codec: c.codec, width, height, framerate, latencyMode: "quality", ...c.extra };
    if (quality !== null) {
      const config = { ...base, bitrateMode: "quantizer" } as VideoEncoderConfig;
      if (await supported(config)) return { config, mux: c.mux, quantizer: quantizerFor(c.mux, quality) };
    }
    for (const factor of [1, 0.6, 0.35]) {
      const config: VideoEncoderConfig = { ...base, bitrate: Math.round(bitrate * factor), bitrateMode: "variable" };
      if (await supported(config)) return { config, mux: c.mux, quantizer: null };
    }
  }
  throw new Error("This browser can't encode video. Use a recent Chrome, Edge or Safari.");
}

async function supported(config: VideoEncoderConfig) {
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

function candidates(width: number, height: number, bitrate: number): { codec: string; mux: Mux; extra?: Partial<VideoEncoderConfig> }[] {
  const area = width * height;
  // H.264 level: enough for the frame size and for the bitrate (High profile limits: 3.1 ≈ 17.5, 4.2 ≈ 62.5, 5.1 ≈ 300 Mb/s).
  const byArea = area <= 921_600 ? 0 : area <= 2_228_224 ? 1 : area <= 8_912_896 ? 2 : 3;
  const byRate = bitrate <= 17.5e6 ? 0 : bitrate <= 62.5e6 ? 1 : 2;
  const avcLevel = ["1f", "2a", "33", "34"][Math.max(byArea, byRate)];
  const avc = { avc: { format: "avc" } } as Partial<VideoEncoderConfig>;
  return [
    { codec: `avc1.6400${avcLevel}`, mux: "avc", extra: avc },
    { codec: `avc1.4d00${avcLevel}`, mux: "avc", extra: avc },
    // Constrained Baseline: Firefox (and Zen and other Firefox-based browsers) encode H.264
    // with OpenH264, which makes nothing else. Any H.264 plays where VP9 and HEVC don't.
    { codec: `avc1.42e0${avcLevel}`, mux: "avc", extra: avc },
    { codec: "hvc1.1.6.L123.B0", mux: "hevc", extra: { hevc: { format: "hevc" } } as Partial<VideoEncoderConfig> },
    { codec: "vp09.00.41.08", mux: "vp9" },
    { codec: "av01.0.08M.08", mux: "av1" },
  ];
}
