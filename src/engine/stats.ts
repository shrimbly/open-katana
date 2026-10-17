export function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: ArrayLike<number>): number {
  if (!values.length) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return s / values.length;
}

export function std(values: ArrayLike<number>): number {
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (values[i]! - m) ** 2;
  return values.length ? Math.sqrt(s / values.length) : 0;
}

/** Centered moving average with a window of `radius` samples on each side, clamped at the edges. */
export function smooth(values: ArrayLike<number>, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      s += values[j]!;
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

/** Median of a centered window, excluding the center sample. */
export function localMedian(values: ArrayLike<number>, i: number, radius: number): number {
  const window: number[] = [];
  for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
    if (j !== i) window.push(values[j]!);
  }
  return median(window);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const round = (v: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
