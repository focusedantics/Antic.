import { isHex, normalizeHex, rgbToHex } from "@/lib/hsv";

/**
 * Palette files in and out: GIMP palettes (.gpl), Adobe Swatch Exchange (.ase, RGB and
 * grey swatches), JSON (a list of colours, or { name, colors }) and plain hex lists
 * (.txt / .hex, one colour per line, as Lospec exports them).
 */
export type PaletteFile = { name: string; colors: string[] };

export async function readPaletteFile(file: File): Promise<PaletteFile> {
  const base = file.name.replace(/\.[^.]+$/, "") || "Palette";
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "ase") return readAse(new Uint8Array(await file.arrayBuffer()), base);
  const text = await file.text();
  if (ext === "gpl" || text.startsWith("GIMP Palette")) return readGpl(text, base);
  if (ext === "json" || text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) return readJson(text, base);
  return readHexList(text, base);
}

const unique = (colors: string[]) => [...new Set(colors)].slice(0, 256);

export function readGpl(text: string, fallback = "Palette"): PaletteFile {
  let name = fallback;
  const colors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const named = /^Name:\s*(.+)$/i.exec(line);
    if (named) name = named[1].trim() || name;
    const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (m) colors.push(rgbToHex({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }));
  }
  if (!colors.length) throw new Error("No colours found in this GIMP palette.");
  return { name, colors: unique(colors) };
}

export function readJson(text: string, fallback = "Palette"): PaletteFile {
  const v = JSON.parse(text) as unknown;
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? ((v as { colors?: unknown }).colors ?? (v as { colours?: unknown }).colours) : null;
  const name = v && typeof v === "object" && !Array.isArray(v) && typeof (v as { name?: unknown }).name === "string" ? ((v as { name: string }).name || fallback) : fallback;
  const colors = (Array.isArray(list) ? list : []).flatMap((c) => {
    const s = typeof c === "string" ? c : c && typeof c === "object" ? ((c as { hex?: unknown; color?: unknown }).hex ?? (c as { color?: unknown }).color) : null;
    const h = typeof s === "string" ? normalizeHex(s) : null;
    return h ? [h] : [];
  });
  if (!colors.length) throw new Error("No colours found in this file.");
  return { name: name.slice(0, 120), colors: unique(colors) };
}

export function readHexList(text: string, fallback = "Palette"): PaletteFile {
  const colors = (text.match(/#?\b[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? []).flatMap((s) => normalizeHex(s) ?? []);
  if (!colors.length) throw new Error("No colours found in this file.");
  return { name: fallback, colors: unique(colors) };
}

/** Adobe Swatch Exchange: big-endian blocks; colour entries carry a model and float components. */
export function readAse(bytes: Uint8Array, fallback = "Palette"): PaletteFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(0, 4)) !== "ASEF") throw new Error("Not an Adobe swatch file.");
  const count = view.getUint32(8);
  let p = 12;
  let name = fallback;
  const colors: string[] = [];
  for (let i = 0; i < count && p + 6 <= bytes.length; i++) {
    const type = view.getUint16(p);
    const length = view.getUint32(p + 2);
    const start = p + 6;
    p = start + length;
    if (type === 0xc001) {
      // Group start: its name names the palette.
      const n = view.getUint16(start);
      name = readUtf16(view, start + 2, n) || name;
      continue;
    }
    if (type !== 0x0001) continue;
    const nameLength = view.getUint16(start);
    let q = start + 2 + nameLength * 2;
    const model = String.fromCharCode(...bytes.slice(q, q + 4)).trim();
    q += 4;
    const f = (k: number) => view.getFloat32(q + k * 4);
    if (model === "RGB") colors.push(rgbToHex({ r: f(0) * 255, g: f(1) * 255, b: f(2) * 255 }));
    else if (model === "Gray") colors.push(rgbToHex({ r: f(0) * 255, g: f(0) * 255, b: f(0) * 255 }));
    else if (model === "CMYK") {
      const [c, m, y, k] = [f(0), f(1), f(2), f(3)];
      colors.push(rgbToHex({ r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) }));
    }
  }
  if (!colors.length) throw new Error("No colours found in this swatch file.");
  return { name, colors: unique(colors) };
}

function readUtf16(view: DataView, at: number, units: number) {
  let s = "";
  for (let i = 0; i < units; i++) {
    const c = view.getUint16(at + i * 2);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}

export function writeGpl(p: PaletteFile): string {
  const lines = [`GIMP Palette`, `Name: ${p.name}`, `Columns: ${Math.min(16, p.colors.length)}`, "#"];
  for (const c of p.colors.filter(isHex)) {
    const n = parseInt(c.slice(1), 16);
    lines.push(`${String((n >> 16) & 255).padStart(3)} ${String((n >> 8) & 255).padStart(3)} ${String(n & 255).padStart(3)}\t${c}`);
  }
  return `${lines.join("\n")}\n`;
}

export const writeJson = (p: PaletteFile) => `${JSON.stringify({ name: p.name, colors: p.colors }, null, 2)}\n`;
export const writeHexList = (p: PaletteFile) => `${p.colors.map((c) => c.slice(1).toUpperCase()).join("\n")}\n`;

/** An Adobe Swatch Exchange file with the palette as one named group of RGB swatches. */
export function writeAse(p: PaletteFile): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const f32 = (v: number) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    parts.push(b.getUint8(0), b.getUint8(1), b.getUint8(2), b.getUint8(3));
  };
  const str = (s: string) => {
    u16(s.length + 1);
    for (const ch of s) u16(ch.charCodeAt(0));
    u16(0);
  };
  const colors = p.colors.filter(isHex);
  parts.push(..."ASEF".split("").map((c) => c.charCodeAt(0)));
  u16(1);
  u16(0);
  u32(colors.length + 2);
  // Group start.
  u16(0xc001);
  u32(2 + (p.name.length + 1) * 2);
  str(p.name);
  for (const c of colors) {
    const n = parseInt(c.slice(1), 16);
    u16(0x0001);
    u32(2 + 8 * 2 + 4 + 12 + 2);
    str(c.toUpperCase().slice(0, 7));
    parts.push(..."RGB ".split("").map((ch) => ch.charCodeAt(0)));
    f32(((n >> 16) & 255) / 255);
    f32(((n >> 8) & 255) / 255);
    f32((n & 255) / 255);
    u16(2); // normal (not global or spot)
  }
  // Group end.
  u16(0xc002);
  u32(0);
  return new Uint8Array(parts);
}
