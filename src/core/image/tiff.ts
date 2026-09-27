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
