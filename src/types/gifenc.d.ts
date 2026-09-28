// gifenc 1.0.3 (MIT) ships without type declarations; this covers the parts Focused uses.
declare module "gifenc" {
  export type Palette = number[][];
  export type GifFrameOptions = { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number };
  export type GifEncoderInstance = {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number; clearAlpha?: boolean }): Palette;
}
