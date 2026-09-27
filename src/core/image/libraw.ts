import type LibRawType from "libraw-wasm";
import type { Metadata, RawImageData } from "libraw-wasm";

/**
 * LibRaw (via LibRaw-Wasm) decodes camera RAW files in its own worker. It is a
 * pthreads build, so it only loads on a cross-origin isolated page. The module
 * is imported on first use, keeping ~1.4 MB of WASM off the startup path.
 */
let loading: Promise<typeof LibRawType> | null = null;

export function isRawDecodingAvailable() {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

async function libraw() {
  if (!isRawDecodingAvailable())
    throw new Error("RAW decoding needs a cross-origin isolated page (COOP/COEP headers).");
  loading ??= import("libraw-wasm").then((m) => m.default);
  return loading;
}

export type RawDecodeOptions = {
  /** Half-size decode skips demosaicing: 4× fewer pixels, much faster. */
  halfSize?: boolean;
  /** Linear 16-bit Rec.2020 for development, or display-referred 8-bit sRGB for previews. */
  output: "linear" | "display";
};

export type RawDecodeResult = { image: RawImageData; metadata: Metadata | undefined };

/** LibRaw output_color value for Rec.2020 primaries (LibRaw ≥ 0.20). */
export const LIBRAW_REC2020 = 8;

export async function decodeRaw(bytes: Uint8Array, options: RawDecodeOptions): Promise<RawDecodeResult> {
  const LibRaw = await libraw();
  const raw = new LibRaw();
  try {
    // open() transfers the buffer to LibRaw's worker; pass a copy so callers keep theirs.
    await raw.open(bytes.slice(), {
      halfSize: options.halfSize ?? false,
      useCameraWb: true,
      noAutoBright: true,
      ...(options.output === "linear"
        ? { outputBps: 16, outputColor: LIBRAW_REC2020, gamm: [1, 1] }
        : { outputBps: 8, outputColor: 1 }),
      // AHD: a good speed/quality balance for a first render.
      userQual: 3,
    });
    const metadata = await raw.metadata(true);
    const image = await raw.imageData();
    if (!image?.data || !image.width) throw new Error("LibRaw returned no image");
    return { image, metadata };
  } finally {
    raw.dispose();
  }
}

export async function readRawMetadata(bytes: Uint8Array): Promise<Metadata | undefined> {
  const LibRaw = await libraw();
  const raw = new LibRaw();
  try {
    await raw.open(bytes.slice(), {});
    return await raw.metadata(true);
  } finally {
    raw.dispose();
  }
}
