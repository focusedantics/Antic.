import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { catalogDb, getThumb, putDevelopedThumb, putThumb, putThumbBase, undevelopedPreview } from "@/core/catalog/db";
import { byteSizeOf, formatBytes, measureStorage } from "@/core/catalog/usage";

describe("storage use", () => {
  it("sizes values: blobs and buffers exactly, records about right", () => {
    expect(byteSizeOf(new Blob([new Uint8Array(1234)]))).toBe(1234);
    expect(byteSizeOf(new Uint8Array(500))).toBe(500);
    expect(byteSizeOf(new ArrayBuffer(64))).toBe(64);
    expect(byteSizeOf({ name: "abc", size: 3, on: true, none: null })).toBe(4 + 3 + 4 + 8 + 2 + 1 + 4);
    expect(byteSizeOf([{ thumb: new Blob(["12345"]) }, "xy"])).toBe(5 + 5 + 2);
    // A structure that refers to itself does not hang.
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(byteSizeOf(loop)).toBeGreaterThan(0);
  });

  it("formats sizes as people read them", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(48_300_000)).toBe("48 MB");
    expect(formatBytes(999_900_000)).toBe("1.0 GB");
    expect(formatBytes(2_340_000_000)).toBe("2.3 GB");
  });

  it("counts every category without reading originals", async () => {
    const db = await catalogDb();
    const blob = (n: number) => new Blob([new Uint8Array(n)]);
    // Two photos stored here, one read from a folder in place (no original kept).
    await db.put("originals", blob(10), "a");
    await db.put("originals", { opfs: "original-b", type: "image/x-adobe-dng", size: 75_000_000 }, "b");
    await db.put("thumbs", { thumb: blob(2000), preview: blob(90_000), previewSource: "decoded", revision: -1 }, "a");
    await db.put("thumbs", { thumb: blob(3000), previewSource: "embedded", revision: -1 }, "b");
    await db.put("documents", { id: "d1", name: "Poster", updatedAt: 1, data: { purpose: "design", layers: [] }, thumb: blob(40_000) });
    await db.put("documents", { id: "d2", name: "Montage", updatedAt: 1, data: { layers: [] } });
    await db.put("rasters", { id: "r1", width: 100, height: 50, data: new Uint8Array(5000), createdAt: 1 });
    await db.put("videos", { id: "v1", name: "clip.mp4", type: "video/mp4", byteSize: 300_000_000, duration: 4, width: 1920, height: 1080, createdAt: 1, updatedAt: 1, poster: blob(8000), edit: {} });
    await db.put("videoFiles", { opfs: "video-v1", type: "video/mp4", size: 300_000_000 }, "v1");
    await db.put("designAssets", { id: "t1", kind: "font", name: "Mine", folder: "", createdAt: 1, updatedAt: 1, data: { bytes: new Uint8Array(60_000) } });
    const stages: string[] = [];
    const usage = await measureStorage({
      assets: [
        { id: "a", fileName: "a.jpg", byteSize: 4_000_000 },
        { id: "b", fileName: "b.dng", byteSize: 75_000_000 },
        { id: "c", fileName: "c.jpg", byteSize: 9_000_000 },
      ],
      onStage: (s) => stages.push(s),
    });
    const row = (id: string) => usage.rows.find((r) => r.id === id)!;
    // The photo's recorded file size stands for the stored original.
    expect(row("originals")).toMatchObject({ bytes: 79_000_000, count: 2 });
    expect(usage.linked).toBe(1);
    expect(row("thumbnails")).toMatchObject({ bytes: 5000, count: 2 });
    expect(row("previews")).toMatchObject({ bytes: 90_000, count: 1 });
    expect(row("videos").bytes).toBeGreaterThanOrEqual(300_008_000);
    expect(row("designs").count).toBe(1);
    expect(row("designs").bytes).toBeGreaterThan(40_000);
    expect(row("compositions").count).toBe(1);
    expect(row("masks").bytes).toBeGreaterThanOrEqual(5000);
    expect(row("things").bytes).toBeGreaterThanOrEqual(60_000);
    expect(usage.counted).toBe(usage.rows.reduce((t, r) => t + r.bytes, 0));
    // Biggest first: the clip, the RAW, then the JPEG.
    expect(usage.largest.slice(0, 3).map((i) => i.name)).toEqual(["clip.mp4", "b.dng", "a.jpg"]);
    expect(stages).toContain("masks");
    expect(usage.leftover).toEqual([]);
  });

  it("a developed preview never replaces the camera's own: it is kept beside it", async () => {
    const blob = (n: number) => new Blob([new Uint8Array(n)]);
    const camera = blob(900);
    await putThumb("raw1", { thumb: blob(50), preview: camera, previewSource: "embedded", revision: -1 });
    expect(undevelopedPreview(await getThumb("raw1"))?.size).toBe(900);
    await putDevelopedThumb("raw1", { thumb: blob(60), preview: blob(1200), revision: 3 });
    await putDevelopedThumb("raw1", { thumb: blob(61), preview: blob(1300), revision: 4 });
    const record = (await getThumb("raw1"))!;
    expect(record).toMatchObject({ previewSource: "developed", revision: 4 });
    expect(record.preview?.size).toBe(1300);
    expect(record.base?.size).toBe(900);
    expect(undevelopedPreview(record)?.size).toBe(900);
    // An older record that only has a developed preview: none to draw from until one is made again.
    await putThumb("raw2", { thumb: blob(50), preview: blob(1000), previewSource: "developed", revision: 2 });
    expect(undevelopedPreview(await getThumb("raw2"))).toBeUndefined();
    await putThumbBase("raw2", blob(700));
    expect(undevelopedPreview(await getThumb("raw2"))?.size).toBe(700);
    // The unedited preview is counted with the previews.
    const usage = await measureStorage({ assets: [] });
    expect(usage.rows.find((r) => r.id === "previews")!.bytes).toBeGreaterThanOrEqual(1300 + 900 + 1000 + 700);
  });
});
