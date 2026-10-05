import { expect, type Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { moovAtEnd, quickTimeAac } from "../tests/fixtures/moov";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function openVideo(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, phone = false) {
  await page.addInitScript(() => localStorage.setItem("focused:prefs", JSON.stringify({ tourDone: true, backdrop: false })));
  await page.goto("/");
  await page.evaluate(() => indexedDB.deleteDatabase("focused-catalog"));
  await page.reload();
  if (phone) {
    await page.getByRole("button", { name: /^Workspace:/ }).tap();
    await page.getByRole("menuitemradio", { name: "Video" }).tap();
  } else await page.getByRole("button", { name: "Video", exact: true }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Video…" }).click()]);
  await chooser.setFiles(file);
  await expect(page.getByTestId("segment")).toHaveCount(1, { timeout: 30_000 });
}

const clip = () => ({ name: "clip.mp4", mimeType: "video/mp4", buffer: readFileSync("tests/fixtures/clip.mp4") });

test("decoding the audio track sample by sample (no whole-file read) matches the browser's own decode", async ({ page }) => {
  await openVideo(page, clip());
  const result = await page.evaluate(async () => {
    const { mediaFromFile } = await import("/src/core/video/media.ts" as string);
    const { decodeTrackWithWebCodecs } = await import("/src/core/video/soundtrack.ts" as string);
    const { video } = await import("/src/core/video/session.ts" as string);
    const { getVideoFile } = await import("/src/core/catalog/db.ts" as string);
    const blob: Blob = await getVideoFile(video.getState().openId);
    const media = await mediaFromFile("x", blob);
    const streamed: Float32Array[] = await decodeTrackWithWebCodecs(media.media.audio);
    const whole = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await blob.arrayBuffer());
    const reference = whole.getChannelData(0);
    // Compare a stretch of the left channel.
    const n = Math.min(reference.length, streamed[0].length) - 4800;
    let dot = 0;
    let a2 = 0;
    let b2 = 0;
    for (let i = 4800; i < n; i++) {
      dot += reference[i] * streamed[0][i];
      a2 += reference[i] ** 2;
      b2 += streamed[0][i] ** 2;
    }
    return { streamed: streamed[0].length, whole: reference.length, correlation: dot / Math.sqrt(a2 * b2), energy: b2 };
  });
  expect(result.energy).toBeGreaterThan(1);
  expect(Math.abs(result.streamed - result.whole)).toBeLessThan(48000 * 0.05);
  expect(result.correlation).toBeGreaterThan(0.99);
});

test.describe("iPhone", () => {
  test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });

  test("play puts the page in the playback audio session, so the silent switch doesn't mute the video", async ({ page }) => {
    // Safari's Audio Session API (absent in this browser): a stand-in that records the type.
    await page.addInitScript(() => Object.defineProperty(navigator, "audioSession", { value: { type: "auto" }, configurable: true }));
    await openVideo(page, clip(), true);
    expect(await page.evaluate(() => (navigator as Navigator & { audioSession: { type: string } }).audioSession.type)).toBe("auto");
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    expect(await page.evaluate(() => (navigator as Navigator & { audioSession: { type: string } }).audioSession.type)).toBe("playback");
    await page.getByRole("button", { name: "Pause", exact: true }).tap();
  });

  test("a .MOV whose sound can't be decoded here says so instead of going quietly silent", async ({ page }) => {
    // AAC described the QuickTime way; this test browser has no AAC decoder at all.
    const mov = quickTimeAac(moovAtEnd(new Uint8Array(readFileSync("tests/fixtures/clip.mp4"))));
    await openVideo(page, { name: "IMG_0001.MOV", mimeType: "video/quicktime", buffer: Buffer.from(mov) }, true);
    await expect(page.locator(".vv-status").filter({ hasText: "No sound" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("viewer")).toBeVisible();
  });
});

test("an MP4's AAC sound is described correctly even when the encoder describes it wrong (Safari)", async ({ page }) => {
  // Safari's AAC AudioEncoder reports an AudioSpecificConfig that reads as 22050 Hz with no
  // channels (WebKit bug 302253); an MP4 carrying it plays silent. This browser has no AAC
  // encoder at all, so a stand-in behaves like Safari's.
  await page.addInitScript(() => {
    class SafariLikeAacEncoder {
      state = "unconfigured";
      private output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void;
      private pending = 0;
      private time = 0;
      private described = false;
      constructor(init: { output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void }) {
        this.output = init.output;
      }
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: config.codec === "mp4a.40.2", config };
      }
      configure() {
        this.state = "configured";
      }
      encode(data: AudioData) {
        this.pending += data.numberOfFrames;
        while (this.pending >= 1024) {
          this.pending -= 1024;
          const chunk = new EncodedAudioChunk({ type: "key", timestamp: this.time, duration: (1024 / 48000) * 1e6, data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]) });
          this.time += (1024 / 48000) * 1e6;
          const meta = this.described ? undefined : { decoderConfig: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x03, 0x80]) } };
          this.described = true;
          this.output(chunk, meta);
        }
      }
      async flush() {}
      close() {
        this.state = "closed";
      }
    }
    Object.defineProperty(window, "AudioEncoder", { value: SafariLikeAacEncoder, configurable: true, writable: true });
  });
  await openVideo(page, clip());
  const result = await page.evaluate(async () => {
    const { video } = await import("/src/core/video/session.ts" as string);
    const { loadClipMedia } = await import("/src/core/video/media.ts" as string);
    const { exportEdit } = await import("/src/core/video/export.ts" as string);
    const state = video.getState();
    const own = await loadClipMedia(state.openId);
    // Quieter, so the clip is re-encoded rather than copied as it is.
    const edit = { ...state.edit, segments: state.edit.segments.map((s: { volume: number }) => ({ ...s, volume: 0.8 })), output: { ...state.edit.output, format: "mp4-h264", audio: true } };
    const out = await exportEdit(own, edit, loadClipMedia, () => {}, new AbortController().signal);
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    // The esds box's DecoderSpecificInfo (tag 5) holds the AudioSpecificConfig.
    let at = -1;
    for (let i = 0; i < bytes.length - 4; i++)
      if (bytes[i] === 0x65 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x64 && bytes[i + 3] === 0x73) at = i;
    if (at < 0) return { esds: false, asc: [] as number[], note: out.note ?? null, copied: out.copied };
    for (let i = at; i < at + 64; i++)
      if (bytes[i] === 0x05) {
        let j = i + 1;
        let len = 0;
        // Expandable length (1–4 bytes, high bit continues).
        for (let k = 0; k < 4; k++, j++) {
          len = (len << 7) | (bytes[j] & 0x7f);
          if (!(bytes[j] & 0x80)) {
            j++;
            break;
          }
        }
        return { esds: true, asc: [...bytes.subarray(j, j + len)], note: out.note ?? null, copied: out.copied };
      }
    return { esds: true, asc: [] as number[], note: out.note ?? null, copied: out.copied };
  });
  expect(result).toEqual({ esds: true, asc: [0x11, 0x90], note: null, copied: false });
});
