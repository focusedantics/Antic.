import UTIF from "utif2";

type Ifd = { width: number; height: number; data: Uint8Array; t258?: number[]; t277?: number[]; t284?: number[]; t339?: number[] } & Record<string, unknown>;

function firstImage(bytes: Uint8Array): Ifd {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = UTIF.decode(buffer) as unknown as Ifd[];
  // Pick the largest IFD: some TIFFs store a thumbnail first.
  const main = ifds
    .filter((i) => i.t256 && i.t257)
    .sort((a, b) => Number(b.t256) * Number(b.t257) - Number(a.t256) * Number(a.t257))[0];
  if (!main) throw new Error("TIFF: no image found");
  UTIF.decodeImage(buffer, main as never);
  return main;
}

/** 8-bit display rendering (thumbnails, previews). */
export async function decodeTiffToBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  const ifd = firstImage(bytes);
  const rgba = UTIF.toRGBA8(ifd as never);
  const data = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, ifd.width * ifd.height * 4);
  return createImageBitmap(new ImageData(data, ifd.width, ifd.height));
}

/**
 * Full-precision decode for Develop: 16-bit RGB(A) TIFFs keep their 16 bits,
 * everything else goes through the 8-bit path.
 */
export function decodeTiff16(bytes: Uint8Array): { width: number; height: number; data: Uint16Array; channels: 3 | 4 } | null {
  const ifd = firstImage(bytes);
  const bps = ifd.t258?.[0] ?? 8;
  const spp = ifd.t277?.[0] ?? 1;
  const format = ifd.t339?.[0] ?? 1;
  if (bps !== 16 || (spp !== 3 && spp !== 4) || format !== 1) return null;
  const count = ifd.width * ifd.height * spp;
  const view = new DataView(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength);
  if (view.byteLength < count * 2) return null;
  // UTIF normalizes 16-bit samples to little-endian while decoding.
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
  return { width: ifd.width, height: ifd.height, data: out, channels: spp as 3 | 4 };
}

export type DecodedTiff =
  | { kind: "rgb16-linear"; width: number; height: number; data: Uint16Array; white: number }
  | { kind: "image"; image: ImageBitmap; width: number; height: number };

const SRGB_TO_REC2020 = [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956];

/**
 * 16-bit RGB TIFFs keep their precision: samples are decoded from the sRGB
 * transfer curve and converted to linear Rec.2020 here, in the worker. Other
 * TIFFs (8-bit, palette, CMYK…) go through the 8-bit path.
 */
export async function decodeTiffForDevelop(bytes: Uint8Array): Promise<DecodedTiff> {
  const deep = decodeTiff16(bytes);
  if (!deep) {
    const image = await decodeTiffToBitmap(bytes);
    return { kind: "image", image, width: image.width, height: image.height };
  }
  const lut = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const v = i / 65535;
    lut[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  const { width, height, data, channels } = deep;
  const out = new Uint16Array(width * height * 3);
  const m = SRGB_TO_REC2020;
  for (let i = 0, j = 0; i < out.length; i += 3, j += channels) {
    const r = lut[data[j]];
    const g = lut[data[j + 1]];
    const b = lut[data[j + 2]];
    out[i] = Math.min(65535, Math.round((m[0] * r + m[1] * g + m[2] * b) * 65535));
    out[i + 1] = Math.min(65535, Math.round((m[3] * r + m[4] * g + m[5] * b) * 65535));
    out[i + 2] = Math.min(65535, Math.round((m[6] * r + m[7] * g + m[8] * b) * 65535));
  }
  return { kind: "rgb16-linear", width, height, data: out, white: 65535 };
}
