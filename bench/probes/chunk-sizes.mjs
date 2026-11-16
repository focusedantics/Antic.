// Approximate per-module bytes of a chunk from its source map (by generated-column spans).
import { readFileSync } from "node:fs";
const file = process.argv[2];
const map = JSON.parse(readFileSync(file + ".map", "utf8"));
const code = readFileSync(file, "utf8");
const lines = code.split("\n");
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const sizes = new Array(map.sources.length).fill(0);
let src = 0;
map.mappings.split(";").forEach((line, li) => {
  let col = 0; let prevCol = 0; let prevSrc = -1;
  const segs = line.split(",").filter(Boolean);
  const decoded = segs.map((seg) => {
    const out = []; let v = 0, shift = 0;
    for (const ch of seg) { const d = B64.indexOf(ch); v |= (d & 31) << shift; if (d & 32) shift += 5; else { out.push(v & 1 ? -(v >> 1) : v >> 1); v = 0; shift = 0; } }
    return out;
  });
  decoded.forEach((s, i) => {
    col += s[0];
    if (prevSrc >= 0) sizes[prevSrc] += col - prevCol;
    if (s.length >= 4) { src += s[1]; prevSrc = src; } else prevSrc = -1;
    prevCol = col;
  });
  if (prevSrc >= 0) sizes[prevSrc] += (lines[li]?.length ?? prevCol) - prevCol;
});
const groups = new Map();
map.sources.forEach((s, i) => {
  let key = s.replace(/^(\.\.\/)+/, "");
  const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  key = m ? "npm:" + m[1] : key.split("/").slice(0, process.argv[3] ? Number(process.argv[3]) : 3).join("/");
  groups.set(key, (groups.get(key) ?? 0) + sizes[i]);
});
const total = sizes.reduce((a, b) => a + b, 0);
console.log("total mapped", total, "of", code.length);
[...groups].sort((a, b) => b[1] - a[1]).slice(0, 45).forEach(([k, v]) => console.log(String(Math.round(v / 1024)).padStart(5), "kB", k));
