import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("import fingerprint", () => {
  it("works on pages without crypto.subtle (a phone on the dev server over http://)", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a });
    const { fingerprint } = await import("@/core/catalog/import");
    const a = await fingerprint(new Blob([new Uint8Array([1, 2, 3, 4])]));
    const b = await fingerprint(new Blob([new Uint8Array([1, 2, 3, 5])]));
    expect(a).toMatch(/^fnv-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(await fingerprint(new Blob([new Uint8Array([1, 2, 3, 4])]))).toBe(a);
  });

  it("uses SHA-256 where it can", async () => {
    const { fingerprint } = await import("@/core/catalog/import");
    expect(await fingerprint(new Blob([new Uint8Array([1, 2, 3])]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("picker accept lists", () => {
  it("asks an iPhone's photo library for everything, so nothing is greyed out or converted to HEIC", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 });
    const { pickerAccept } = await import("@/lib/files");
    expect(pickerAccept(".jpg,.heic,image/heic", { images: true, videos: true })).toBe("image/*,video/*");
    expect(pickerAccept(".focused,application/zip", {})).toBe("");
  });

  it("keeps the precise list on a computer", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 });
    const { pickerAccept } = await import("@/lib/files");
    expect(pickerAccept(".jpg,.heic,image/heic", { images: true, videos: true })).toBe(".jpg,.heic,image/heic");
  });
});
