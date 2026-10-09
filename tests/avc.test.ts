import { describe, expect, it } from "vitest";
import { annexBUnits, avcDescription, AvcFixer } from "@/core/video/avc";

// A Constrained Baseline SPS (level 3.1), a PPS, an IDR slice and a non-IDR slice (payloads shortened).
const SPS = [0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40];
const PPS = [0x68, 0xce, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x21];
const P = [0x41, 0x9a, 0x22];
const AUD = [0x09, 0xf0];

const chunk = (bytes: number[]) =>
  ({ byteLength: bytes.length, copyTo: (dst: Uint8Array) => dst.set(bytes), type: "key", timestamp: 0, duration: 33333 }) as unknown as EncodedVideoChunk;

describe("H.264 output for MP4", () => {
  it("splits Annex B on 3- and 4-byte start codes, and knows avc samples aren't Annex B", () => {
    const stream = new Uint8Array([0, 0, 0, 1, ...SPS, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...IDR]);
    expect(annexBUnits(stream)?.map((n) => [...n])).toEqual([SPS, PPS, IDR]);
    expect(annexBUnits(new Uint8Array([0, 0, 0, 5, ...IDR]))).toBeNull();
  });

  it("builds the avcC from the stream's own SPS and PPS", () => {
    const d = avcDescription(new Uint8Array(SPS), new Uint8Array(PPS));
    expect([...d]).toEqual([1, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS]);
    // High profile: chroma format and bit depths follow.
    const high = [0x67, 100, 0, 0x28, 0xac];
    expect([...avcDescription(new Uint8Array(high), new Uint8Array(PPS)).slice(-4)]).toEqual([0xfd, 0xf8, 0xf8, 0]);
  });

  it("turns Annex B frames into length-prefixed samples with the description on the first", () => {
    const fixer = new AvcFixer();
    const first = fixer.fix(chunk([0, 0, 0, 1, ...AUD, 0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 1, ...IDR]), {});
    expect([...first.data]).toEqual([0, 0, 0, IDR.length, ...IDR]);
    expect(first.meta?.decoderConfig?.codec).toBe("avc1.42c01f");
    expect([...(first.meta?.decoderConfig?.description as Uint8Array)]).toEqual([...avcDescription(new Uint8Array(SPS), new Uint8Array(PPS))]);
    const next = fixer.fix(chunk([0, 0, 0, 1, ...P]));
    expect([...next.data]).toEqual([0, 0, 0, P.length, ...P]);
    expect(next.meta).toBeUndefined();
  });

  it("leaves avc output (with its description) as it is", () => {
    const sample = [0, 0, 0, IDR.length, ...IDR];
    const meta = { decoderConfig: { codec: "avc1.640028", description: new Uint8Array([1, 2, 3]) } };
    const out = new AvcFixer().fix(chunk(sample), meta);
    expect([...out.data]).toEqual(sample);
    expect(out.meta).toBe(meta);
  });
});
