import { streamRecords } from "../util/proc.js";

/** Low-resolution per-frame data used by every analysis pass. */
export interface FrameFeatures {
  width: number;
  height: number;
  count: number;
  /** Grayscale thumbnail per frame (width × height bytes). */
  gray: Uint8Array[];
  /** Mean luma per frame, 0–1. */
  luma: Float32Array;
  /** Mean saturation per frame, 0–1. */
  saturation: Float32Array;
  /** Normalized color histogram per frame (HIST_BINS³ bins of RGB). */
  hist: Float32Array[];
  /** Mean colour per frame: R, G, B (0–255) for frame i at 3i, 3i+1, 3i+2. */
  meanRgb: Float32Array;
}

export const HIST_BINS = 4;

export function analysisSize(displayWidth: number, displayHeight: number, maxSide: number): { width: number; height: number } {
  const scale = maxSide / Math.max(displayWidth, displayHeight, 1);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(displayWidth), height: even(displayHeight) };
}

/**
 * Decodes every native frame (no frame-rate conversion) at a small size and computes features.
 * `onFrame` is called with the number of frames read so far, after each frame.
 */
export async function extractFeatures(
  path: string,
  displayWidth: number,
  displayHeight: number,
  maxSide = 128,
  opts: { onFrame?: (n: number) => void } = {},
): Promise<FrameFeatures> {
  const { width, height } = analysisSize(displayWidth, displayHeight, maxSide);
  const pixels = width * height;
  const gray: Uint8Array[] = [];
  const hist: Float32Array[] = [];
  const luma: number[] = [];
  const saturation: number[] = [];
  const meanRgb: number[] = [];
  const binScale = HIST_BINS / 256;

  await streamRecords(
    "ffmpeg",
    [
      "-v", "error",
      "-i", path,
      "-map", "0:v:0",
      "-fps_mode", "passthrough",
      "-vf", `scale=${width}:${height}:flags=area,format=rgb24`,
      "-f", "rawvideo",
      "pipe:1",
    ],
    pixels * 3,
    (rgb) => {
      const g = new Uint8Array(pixels);
      const h = new Float32Array(HIST_BINS ** 3);
      let lumaSum = 0;
      let satSum = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let p = 0, o = 0; p < pixels; p++, o += 3) {
        const r = rgb[o]!;
        const gr = rgb[o + 1]!;
        const b = rgb[o + 2]!;
        rSum += r;
        gSum += gr;
        bSum += b;
        const y = (77 * r + 150 * gr + 29 * b) >> 8;
        g[p] = y;
        lumaSum += y;
        const max = Math.max(r, gr, b);
        const min = Math.min(r, gr, b);
        satSum += max === 0 ? 0 : (max - min) / max;
        const bin = ((r * binScale) | 0) * HIST_BINS * HIST_BINS + ((gr * binScale) | 0) * HIST_BINS + ((b * binScale) | 0);
        h[bin]! += 1;
      }
      for (let i = 0; i < h.length; i++) h[i]! /= pixels;
      gray.push(g);
      hist.push(h);
      luma.push(lumaSum / pixels / 255);
      saturation.push(satSum / pixels);
      meanRgb.push(rSum / pixels, gSum / pixels, bSum / pixels);
      opts.onFrame?.(gray.length);
    },
  );

  return {
    width,
    height,
    count: gray.length,
    gray,
    hist,
    luma: Float32Array.from(luma),
    saturation: Float32Array.from(saturation),
    meanRgb: Float32Array.from(meanRgb),
  };
}

/** Half of the L1 distance between two normalized histograms, in [0, 1]. */
export function histDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / 2;
}

/** Mean absolute luma difference between two thumbnails, in [0, 1]. */
export function pixelDistance(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length / 255;
}

/**
 * Normalized cross-correlation of two thumbnails, in [-1, 1]. Invariant to brightness and contrast,
 * so a glow or exposure pulse on the same picture stays near 1 while a real cut drops.
 */
export function correlation(a: Uint8Array, b: Uint8Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
