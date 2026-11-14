/**
 * A camera-style RAW for tests: an uncompressed RGGB Bayer DNG of `width × height` with a
 * smooth colour pattern, as LibRaw reads it. Big ones stand in for real 24–60 megapixel RAWs.
 * `linear` writes it the way iPhone ProRAW does (already RGB, PhotometricInterpretation
 * "linear raw"); `preview` appends an embedded JPEG; `pixels: false` declares the size but
 * stores no pixel data (for paths that must never decode it); `previewIfd` puts a
 * same-size preview's tags first (IFD0), as real DNGs do, with the RAW chained after it.
 */
export function testDng(
  width: number,
  height: number,
  { linear = false, preview, pixels: withPixels = true, previewIfd = false }: { linear?: boolean; preview?: Buffer; pixels?: boolean; previewIfd?: boolean } = {},
): Buffer {
  const channels = linear ? 3 : 1;
  const pixels = new Uint16Array(withPixels ? width * height * channels : 0);
  if (withPixels)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const r = 0.5 + 0.5 * Math.sin(x / 300);
        const g = 0.5 + 0.5 * Math.sin(y / 200 + x / 900);
        const b = 0.5 + 0.5 * Math.cos((x + y) / 500);
        const at = (y * width + x) * channels;
        if (linear) pixels.set([r, g, b].map((v) => Math.round(512 + v * 14000)), at);
        else pixels[at] = Math.round(512 + (y % 2 === 0 ? (x % 2 === 0 ? r : g) : x % 2 === 0 ? g : b) * 14000);
      }
  // [tag, type, values]: type 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 10 SRATIONAL.
  const ascii = (s: string) => [...Buffer.from(`${s}\0`)];
  const tags: [number, number, (number | [number, number])[]][] = [
    [254, 4, [0]],
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, linear ? [16, 16, 16] : [16]],
    [259, 3, [1]],
    [262, 3, [linear ? 34892 : 32803]], // linear raw, or CFA
    [271, 2, ascii("Focused")],
    [272, 2, ascii("Test Bayer")],
    [273, 4, [0]], // strip offset, set below
    [277, 3, [channels]],
    [278, 4, [height]],
    [279, 4, [width * height * 2 * channels]],
    [284, 3, [1]],
    ...(linear
      ? []
      : ([
          [33421, 3, [2, 2]],
          [33422, 1, [0, 1, 1, 2]], // RGGB
        ] as [number, number, number[]][])),
    [50706, 1, [1, 4, 0, 0]],
    [50708, 2, ascii("Focused Test Bayer")],
    [50714, 3, [512]],
    [50717, 4, [15000]],
    [50721, 10, [[1, 1], [0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [1, 1]]],
    [50728, 5, [[1, 1], [1, 1], [1, 1]]],
    [50778, 3, [21]],
  ];
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 } as Record<number, number>;
  const ifdBytes = 2 + tags.length * 12 + 4;
  const ifd = Buffer.alloc(ifdBytes);
  ifd.writeUInt16LE(tags.length, 0);
  const extras: Buffer[] = [];
  // IFD0: the preview's tags (reduced-resolution image, YCbCr JPEG), chained to the RAW's IFD.
  const previewTags: [number, number, number][] = [
    [254, 4, 1],
    [256, 4, width],
    [257, 4, height],
    [259, 3, 7],
    [262, 3, 6],
  ];
  const lead = previewIfd ? Buffer.alloc(2 + previewTags.length * 12 + 4) : Buffer.alloc(0);
  const start = 8 + lead.length;
  if (previewIfd) {
    lead.writeUInt16LE(previewTags.length, 0);
    previewTags.forEach(([tag, type, v], i) => {
      lead.writeUInt16LE(tag, 2 + i * 12);
      lead.writeUInt16LE(type, 4 + i * 12);
      lead.writeUInt32LE(1, 6 + i * 12);
      if (type === 3) lead.writeUInt16LE(v, 10 + i * 12);
      else lead.writeUInt32LE(v, 10 + i * 12);
    });
    lead.writeUInt32LE(start, lead.length - 4);
  }
  let next = start + ifdBytes;
  let stripAt = 0;
  tags.forEach(([tag, type, values], i) => {
    const at = 2 + i * 12;
    const value = Buffer.alloc(Math.max(4, size[type] * values.length));
    values.forEach((v, j) => {
      if (type === 1 || type === 2) value.writeUInt8(v as number, j);
      else if (type === 3) value.writeUInt16LE(v as number, j * 2);
      else if (type === 4) value.writeUInt32LE(v as number, j * 4);
      else {
        const [n, d] = v as [number, number];
        if (type === 5) value.writeUInt32LE(n, j * 8);
        else value.writeInt32LE(n, j * 8);
        value.writeUInt32LE(d, j * 8 + 4);
      }
    });
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(values.length, at + 4);
    if (tag === 273) stripAt = at + 8;
    if (size[type] * values.length <= 4) value.copy(ifd, at + 8, 0, 4);
    else {
      ifd.writeUInt32LE(next, at + 8);
      const padded = value.length % 2 ? Buffer.concat([value, Buffer.alloc(1)]) : value;
      extras.push(padded);
      next += padded.length;
    }
  });
  ifd.writeUInt32LE(next, stripAt);
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  return Buffer.concat([header, lead, ifd, ...extras, Buffer.from(pixels.buffer), ...(preview ? [preview] : [])]);
}
