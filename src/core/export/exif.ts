import type { ExifSummary } from "@/core/catalog/types";

/**
 * Minimal EXIF writer for exported JPEGs. Browsers encode JPEGs without any
 * metadata; this builds a little-endian TIFF structure with IFD0 and an EXIF
 * sub-IFD and inserts it as an APP1 segment. Orientation is always 1 because
 * exports have their rotation baked in.
 */
type Entry = { tag: number; type: 2 | 3 | 4 | 5; values: number[] | string };

function rational(value: number): [number, number] {
  if (value <= 0) return [0, 1];
  if (value < 1) return [1, Math.round(1 / value)];
  const d = 1000;
  return [Math.round(value * d), d];
}

const exifDate = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function encodeIfd(entries: Entry[], offset: number, next = 0) {
  entries.sort((a, b) => a.tag - b.tag);
  const count = entries.length;
  const headerSize = 2 + count * 12 + 4;
  const extra: number[] = [];
  const view = new DataView(new ArrayBuffer(headerSize));
  view.setUint16(0, count, true);
  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    const data: number[] = [];
    let n: number;
    if (e.type === 2) {
      const text = `${e.values as string}\0`;
      for (const ch of new TextEncoder().encode(text)) data.push(ch);
      n = data.length;
    } else {
      const values = e.values as number[];
      n = e.type === 5 ? values.length / 2 : values.length;
      for (const v of values) {
        const size = e.type === 3 ? 2 : 4;
        for (let b = 0; b < size; b++) data.push((v >>> (8 * b)) & 0xff);
      }
    }
    view.setUint16(at, e.tag, true);
    view.setUint16(at + 2, e.type, true);
    view.setUint32(at + 4, n, true);
    if (data.length <= 4) {
      for (let b = 0; b < data.length; b++) view.setUint8(at + 8 + b, data[b]);
    } else {
      view.setUint32(at + 8, offset + headerSize + extra.length, true);
      extra.push(...data);
      if (extra.length % 2) extra.push(0);
    }
  });
  view.setUint32(2 + count * 12, next, true);
  const out = new Uint8Array(headerSize + extra.length);
  out.set(new Uint8Array(view.buffer), 0);
  out.set(extra, headerSize);
  return out;
}

export function buildExif(exif: ExifSummary, options: { captureTime?: number; software?: string; width: number; height: number }): Uint8Array {
  const ifd0: Entry[] = [{ tag: 0x0112, type: 3, values: [1] }];
  if (exif.make) ifd0.push({ tag: 0x010f, type: 2, values: exif.make });
  if (exif.model) ifd0.push({ tag: 0x0110, type: 2, values: exif.model });
  ifd0.push({ tag: 0x0131, type: 2, values: options.software ?? "Focused" });
  ifd0.push({ tag: 0x0132, type: 2, values: exifDate(Date.now()) });
  if (exif.artist) ifd0.push({ tag: 0x013b, type: 2, values: exif.artist });
  if (exif.copyright) ifd0.push({ tag: 0x8298, type: 2, values: exif.copyright });
  const sub: Entry[] = [
    { tag: 0xa002, type: 4, values: [options.width] },
    { tag: 0xa003, type: 4, values: [options.height] },
    // ColorSpace: sRGB.
    { tag: 0xa001, type: 3, values: [1] },
  ];
  if (options.captureTime) sub.push({ tag: 0x9003, type: 2, values: exifDate(options.captureTime) });
  if (exif.exposureTime) sub.push({ tag: 0x829a, type: 5, values: rational(exif.exposureTime) });
  if (exif.fNumber) sub.push({ tag: 0x829d, type: 5, values: rational(exif.fNumber) });
  if (exif.iso) sub.push({ tag: 0x8827, type: 3, values: [Math.min(65535, exif.iso)] });
  if (exif.focalLength) sub.push({ tag: 0x920a, type: 5, values: rational(exif.focalLength) });
  if (exif.exposureBias !== undefined) {
    const [n, d] = rational(Math.abs(exif.exposureBias));
    sub.push({ tag: 0x9204, type: 5, values: [exif.exposureBias < 0 ? -n >>> 0 : n, d] });
  }
  if (exif.lens) sub.push({ tag: 0xa434, type: 2, values: exif.lens });

  // Layout: "Exif\0\0" | TIFF header (8) | IFD0 | EXIF IFD.
  ifd0.push({ tag: 0x8769, type: 4, values: [0] });
  const ifd0Size = encodeIfd([...ifd0], 8).length;
  const exifOffset = 8 + ifd0Size;
  const pointer = ifd0.find((e) => e.tag === 0x8769)!;
  pointer.values = [exifOffset];
  const ifd0Bytes = encodeIfd(ifd0, 8);
  const subBytes = encodeIfd(sub, exifOffset);
  const tiff = new Uint8Array(8 + ifd0Bytes.length + subBytes.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  tiff.set(ifd0Bytes, 8);
  tiff.set(subBytes, exifOffset);
  const header = new TextEncoder().encode("Exif\0\0");
  const payload = new Uint8Array(header.length + tiff.length);
  payload.set(header, 0);
  payload.set(tiff, header.length);
  return payload;
}

/** Inserts an APP1 EXIF segment right after the JPEG's SOI marker. */
export function insertExif(jpeg: Uint8Array, exifPayload: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG");
  const length = exifPayload.length + 2;
  if (length > 0xffff) return jpeg;
  const out = new Uint8Array(jpeg.length + 4 + exifPayload.length);
  out.set([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff], 0);
  out.set(exifPayload, 6);
  out.set(jpeg.subarray(2), 6 + exifPayload.length);
  return out;
}
