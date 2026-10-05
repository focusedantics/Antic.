import { describe, expect, it } from "vitest";
import { aacAudioSpecificConfig, aacObjectType } from "@/core/video/aac";
import { ascSampleRate } from "@/core/video/demux";

describe("AAC AudioSpecificConfig", () => {
  it("matches the well-known bytes for AAC-LC", () => {
    expect([...aacAudioSpecificConfig(48000, 2)]).toEqual([0x11, 0x90]);
    expect([...aacAudioSpecificConfig(44100, 2)]).toEqual([0x12, 0x10]);
    expect([...aacAudioSpecificConfig(48000, 1)]).toEqual([0x11, 0x88]);
  });

  it("writes an explicit rate when it is not in the table", () => {
    // 5 + 4 + 24 + 4 + 3 bits = 40 bits.
    expect(aacAudioSpecificConfig(50000, 2).length).toBe(5);
  });

  it("reads the object type from a codec string", () => {
    expect(aacObjectType("mp4a.40.2")).toBe(2);
    expect(aacObjectType("opus")).toBeNull();
  });

  it("names the rate our demuxer reads back (also the explicit form)", () => {
    expect(ascSampleRate(aacAudioSpecificConfig(48000, 2))).toBe(48000);
    expect(ascSampleRate(aacAudioSpecificConfig(44100, 1))).toBe(44100);
    expect(ascSampleRate(aacAudioSpecificConfig(50000, 2))).toBe(50000);
    // What Safari's AudioEncoder description parses as (WebKit bug 302253): object type 0, 22050 Hz, no channels.
    expect(ascSampleRate(new Uint8Array([0x03, 0x80]))).toBe(22050);
  });
});
