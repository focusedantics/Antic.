/**
 * Stand-in media for the trailer when trailer/kit/ has none of your own: three photos
 * drawn in the browser (seeded, so every run draws the same pictures). They are
 * placeholders for the pipeline, not footage to publish: put your own photos in the kit.
 *
 * - landscape: a sunset over mountains and a lake, deliberately flat (lifted blacks,
 *   muted colour), so Develop has something to fix in the before/after.
 * - subject: a hot-air balloon against the sky, a clear subject for Remove Background.
 * - extra: desert dunes, the second photo of the carousel.
 *
 * Runs inside the page (OffscreenCanvas, imported through the dev server); returns JPEG
 * bytes as base64.
 */
export async function drawStandIns(): Promise<Record<"landscape" | "subject" | "extra", string>> {
  let seed = 7;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** A ridge line across `w`: midpoint displacement, `rough` px at the widest step. */
  const ridge = (w: number, base: number, rough: number) => {
    const n = 257;
    const ys = new Array<number>(n).fill(base);
    for (let step = n - 1, amp = rough; step > 1; step >>= 1, amp *= 0.55)
      for (let i = step >> 1; i < n; i += step) ys[i] = (ys[i - (step >> 1)] + ys[Math.min(n - 1, i + (step >> 1))]) / 2 + (rand() - 0.5) * amp;
    return ys.map((y, i) => [(i / (n - 1)) * w, y] as const);
  };
  const grain = (g: OffscreenCanvasRenderingContext2D, w: number, h: number, amount: number) => {
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * amount;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  };
  const jpeg = async (c: OffscreenCanvas) => {
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.93 })).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // ── Landscape: sunset, four ridges in haze, a lake, then made flat ──
  const L = new OffscreenCanvas(3000, 2000);
  {
    const g = L.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 1350);
    sky.addColorStop(0, "#1b2550");
    sky.addColorStop(0.45, "#6a4a7e");
    sky.addColorStop(0.75, "#d0705c");
    sky.addColorStop(1, "#f6b56b");
    g.fillStyle = sky;
    g.fillRect(0, 0, 3000, 1400);
    const glow = g.createRadialGradient(1900, 1130, 20, 1900, 1130, 900);
    glow.addColorStop(0, "rgba(255,226,160,0.95)");
    glow.addColorStop(0.12, "rgba(255,190,120,0.6)");
    glow.addColorStop(1, "rgba(255,150,90,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, 3000, 1400);
    g.fillStyle = "#fff1c8";
    g.beginPath();
    g.arc(1900, 1150, 95, 0, Math.PI * 2);
    g.fill();
    const layers: [number, number, string][] = [
      [980, 260, "#7b5a7c"],
      [1080, 300, "#5b4466"],
      [1190, 260, "#3a2d4c"],
      [1300, 200, "#211a30"],
    ];
    for (const [base, rough, color] of layers) {
      const pts = ridge(3000, base, rough);
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, 1500);
      for (const [x, y] of pts) g.lineTo(x, y);
      g.lineTo(3000, 1500);
      g.fill();
      // Haze in front of each ridge.
      const haze = g.createLinearGradient(0, base - 120, 0, base + 220);
      haze.addColorStop(0, "rgba(240,160,120,0)");
      haze.addColorStop(1, "rgba(240,160,120,0.22)");
      g.fillStyle = haze;
      g.fillRect(0, base - 120, 3000, 340);
    }
    // Lake: the scene above, mirrored and darkened, with ripples.
    g.save();
    g.translate(0, 2 * 1400);
    g.scale(1, -1);
    g.globalAlpha = 0.55;
    g.drawImage(L, 0, 800, 3000, 600, 0, 800, 3000, 600);
    g.restore();
    g.fillStyle = "rgba(20,16,40,0.55)";
    g.fillRect(0, 1400, 3000, 600);
    g.strokeStyle = "rgba(255,210,160,0.25)";
    for (let i = 0; i < 160; i++) {
      const y = 1410 + rand() * 590;
      const x = 1900 + (rand() - 0.5) * (300 + (y - 1400) * 1.4);
      g.lineWidth = 2 + rand() * 3;
      g.beginPath();
      g.moveTo(x - 40 - rand() * 80, y);
      g.lineTo(x + 40 + rand() * 80, y);
      g.stroke();
    }
    grain(g, 3000, 2000, 10);
    // Flat, as a camera's neutral rendering of a high-contrast scene: lifted blacks,
    // pulled whites, half the colour.
    const img = g.getImageData(0, 0, 3000, 2000);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      for (let k = 0; k < 3; k++) {
        const v = y + (d[i + k] - y) * 0.5;
        d[i + k] = 62 + v * 0.55;
      }
    }
    g.putImageData(img, 0, 0);
  }

  // ── Subject: a striped hot-air balloon in a blue sky ──
  const S = new OffscreenCanvas(2000, 3000);
  {
    const g = S.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 3000);
    sky.addColorStop(0, "#2f6fc2");
    sky.addColorStop(1, "#bfe0fb");
    g.fillStyle = sky;
    g.fillRect(0, 0, 2000, 3000);
    g.filter = "blur(30px)";
    g.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = 0; i < 9; i++) {
      const cx = rand() * 2000;
      const cy = 400 + rand() * 2400;
      for (let j = 0; j < 6; j++) {
        g.beginPath();
        g.ellipse(cx + (j - 3) * 90, cy + (rand() - 0.5) * 60, 160 + rand() * 120, 70 + rand() * 40, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.filter = "none";
    balloon(g, 1000, 620, 560);
    grain(g, 2000, 3000, 8);
  }

  // ── Extra: dunes at golden hour ──
  const E = new OffscreenCanvas(2000, 2500);
  {
    const g = E.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 1200);
    sky.addColorStop(0, "#f2a65a");
    sky.addColorStop(1, "#fbe1b6");
    g.fillStyle = sky;
    g.fillRect(0, 0, 2000, 2500);
    g.fillStyle = "#fff4dc";
    g.beginPath();
    g.arc(1450, 760, 110, 0, Math.PI * 2);
    g.fill();
    const dunes: [number, string, string][] = [
      [1050, "#d98c4a", "#b8692f"],
      [1350, "#e39a55", "#a95a26"],
      [1700, "#eba862", "#9c4f1f"],
      [2100, "#f0b46c", "#8f461b"],
    ];
    for (const [base, lit, dark] of dunes) {
      const pts = ridge(2000, base, 340);
      g.fillStyle = lit;
      g.beginPath();
      g.moveTo(0, 2500);
      for (const [x, y] of pts) g.lineTo(x, y);
      g.lineTo(2000, 2500);
      g.fill();
      // The shadowed face below each crest.
      g.fillStyle = dark;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(0, 2500);
      for (const [x, y] of pts) g.lineTo(x, y + 60 + Math.sin(x / 180) * 40);
      g.lineTo(2000, 2500);
      g.fill();
      g.globalAlpha = 1;
    }
    grain(g, 2000, 2500, 12);
  }

  return { landscape: await jpeg(L), subject: await jpeg(S), extra: await jpeg(E) };
}

/** A striped hot-air balloon: envelope of radius `r` whose top is at `top`, centred on `cx`. */
export function balloon(g: OffscreenCanvasRenderingContext2D, cx: number, top: number, r: number) {
  const envelope = new Path2D();
  envelope.moveTo(cx - r, top + r);
  envelope.arc(cx, top + r, r, Math.PI, 0);
  envelope.bezierCurveTo(cx + r, top + r + 420, cx + 210, top + r + 640, cx + 150, top + r + 820);
  envelope.lineTo(cx - 150, top + r + 820);
  envelope.bezierCurveTo(cx - 210, top + r + 640, cx - r, top + r + 420, cx - r, top + r);
  g.save();
  g.clip(envelope);
  const stripes = ["#e63946", "#f4d35e", "#1d6fd8", "#f4f1de", "#2a9d8f", "#f4d35e", "#e63946", "#f4f1de"];
  for (let i = 0; i < 16; i++) {
    g.fillStyle = stripes[i % stripes.length];
    g.fillRect(cx - r + i * ((2 * r) / 16), top - 10, (2 * r) / 16 + 1, r * 2 + 900);
  }
  const shade = g.createRadialGradient(cx - 220, top + 380, 60, cx, top + r + 200, r * 1.5);
  shade.addColorStop(0, "rgba(255,255,255,0.35)");
  shade.addColorStop(0.5, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.45)");
  g.fillStyle = shade;
  g.fillRect(cx - r - 10, top - 10, 2 * r + 20, r * 2 + 900);
  g.restore();
  // Ropes and the basket.
  g.strokeStyle = "#3b2a1a";
  g.lineWidth = 6;
  const by = top + r + 1040;
  for (const [x0, x1] of [
    [cx - 150, cx - 95],
    [cx - 50, cx - 35],
    [cx + 50, cx + 35],
    [cx + 150, cx + 95],
  ]) {
    g.beginPath();
    g.moveTo(x0, top + r + 820);
    g.lineTo(x1, by);
    g.stroke();
  }
  g.fillStyle = "#7a4e2a";
  g.fillRect(cx - 110, by, 220, 150);
  g.fillStyle = "#5a361b";
  for (let i = 0; i < 6; i++) g.fillRect(cx - 110, by + 12 + i * 24, 220, 6);
}
