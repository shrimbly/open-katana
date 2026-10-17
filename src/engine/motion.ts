import type { FrameFeatures } from "./frames.js";

/**
 * Global image motion between frame i-1 and frame i, as a similarity transform of the content.
 * Content moving left (tx < 0) means the camera panned right.
 */
export interface MotionSample {
  /** Horizontal content shift, fraction of frame width per frame. */
  tx: number;
  /** Vertical content shift, fraction of frame height per frame. */
  ty: number;
  /** Relative scale change per frame (positive = content grows = zoom in / push in). */
  zoom: number;
  /** Rotation per frame, radians (positive = counter-clockwise). */
  rot: number;
  /** 0–1: share of textured blocks agreeing with the fitted transform. */
  confidence: number;
}

const BLOCK = 8;
const STEP = 12;
const COARSE_RADIUS = 5;
const FINE_RADIUS = 2;
const MIN_CORNER_STRENGTH = 5;

function downsample(src: Uint8Array, w: number, h: number): { data: Uint8Array; w: number; h: number } {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const data = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const i = 2 * y * w + 2 * x;
      data[y * w2 + x] = (src[i]! + src[i + 1]! + src[i + w]! + src[i + w + 1]!) >> 2;
    }
  }
  return { data, w: w2, h: h2 };
}

function sad(a: Uint8Array, b: Uint8Array, w: number, h: number, x: number, y: number, u: number, v: number, size: number): number {
  if (x + u < 0 || y + v < 0 || x + u + size > w || y + v + size > h) return Infinity;
  let s = 0;
  for (let dy = 0; dy < size; dy++) {
    const ra = (y + dy) * w + x;
    const rb = (y + v + dy) * w + x + u;
    for (let dx = 0; dx < size; dx++) s += Math.abs(a[ra + dx]! - b[rb + dx]!);
  }
  return s;
}

/**
 * Shi–Tomasi corner strength: the smaller eigenvalue of the block's gradient structure tensor,
 * per pixel. Low values mean flat or one-directional texture (edges, stripes) whose shift is ambiguous.
 */
function cornerStrength(a: Uint8Array, w: number, x: number, y: number, size: number): number {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = (y + dy) * w + x + dx;
      const gx = (a[i + 1]! - a[i - 1]!) / 2;
      const gy = (a[i + w]! - a[i - w]!) / 2;
      sxx += gx * gx;
      syy += gy * gy;
      sxy += gx * gy;
    }
  }
  const n = size * size;
  const half = (sxx + syy) / 2;
  return (half - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)) / n;
}

/** Ties between equally good shifts resolve toward zero motion instead of the search edge. */
const SHIFT_PENALTY = 0.25;

function bestShift(
  a: Uint8Array, b: Uint8Array, w: number, h: number,
  x: number, y: number, size: number, cu: number, cv: number, radius: number,
): { u: number; v: number; cost: (u: number, v: number) => number } {
  const penalty = SHIFT_PENALTY * size * size;
  const cost = (u: number, v: number) => sad(a, b, w, h, x, y, u, v, size) + penalty * (Math.abs(u) + Math.abs(v));
  let best = Infinity;
  let bu = cu;
  let bv = cv;
  for (let v = cv - radius; v <= cv + radius; v++) {
    for (let u = cu - radius; u <= cu + radius; u++) {
      const s = cost(u, v);
      if (s < best) {
        best = s;
        bu = u;
        bv = v;
      }
    }
  }
  return { u: bu, v: bv, cost };
}

/** Parabolic sub-pixel offset of a minimum from costs at -1, 0, +1. */
function subpixel(left: number, center: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  const denom = left - 2 * center + right;
  if (denom <= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (left - right) / (2 * denom)));
}

interface Vector {
  x: number;
  y: number;
  u: number;
  v: number;
}

/** Least-squares similarity fit: u = tx + s·x − r·y, v = ty + s·y + r·x (x, y centered). */
function fitSimilarity(vs: Vector[]): { tx: number; ty: number; s: number; r: number } {
  let n = 0, sx = 0, sy = 0, su = 0, sv = 0, sxx = 0, syy = 0, sxu = 0, syv = 0, syu = 0, sxv = 0;
  for (const p of vs) {
    n++;
    sx += p.x; sy += p.y; su += p.u; sv += p.v;
    sxx += p.x * p.x; syy += p.y * p.y;
    sxu += p.x * p.u; syv += p.y * p.v; syu += p.y * p.u; sxv += p.x * p.v;
  }
  if (n === 0) return { tx: 0, ty: 0, s: 0, r: 0 };
  const mx = sx / n, my = sy / n, mu = su / n, mv = sv / n;
  const varxy = sxx / n - mx * mx + (syy / n - my * my);
  if (varxy < 1e-6) return { tx: mu, ty: mv, s: 0, r: 0 };
  const s = (sxu / n - mx * mu + (syv / n - my * mv)) / varxy;
  const r = (sxv / n - mx * mv - (syu / n - my * mu)) / varxy;
  return { tx: mu - s * mx + r * my, ty: mv - s * my - r * mx, s, r };
}

function motionBetween(prev: Uint8Array, cur: Uint8Array, w: number, h: number): MotionSample {
  const p2 = downsample(prev, w, h);
  const c2 = downsample(cur, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const vectors: Vector[] = [];
  let textured = 0;
  for (let y = BLOCK; y + 2 * BLOCK <= h; y += STEP) {
    for (let x = BLOCK; x + 2 * BLOCK <= w; x += STEP) {
      if (cornerStrength(prev, w, x, y, BLOCK) < MIN_CORNER_STRENGTH) continue;
      textured++;
      const coarse = bestShift(p2.data, c2.data, p2.w, p2.h, x >> 1, y >> 1, BLOCK >> 1, 0, 0, COARSE_RADIUS);
      const fine = bestShift(prev, cur, w, h, x, y, BLOCK, coarse.u * 2, coarse.v * 2, FINE_RADIUS);
      const c0 = fine.cost(fine.u, fine.v);
      const u = fine.u + subpixel(fine.cost(fine.u - 1, fine.v), c0, fine.cost(fine.u + 1, fine.v));
      const v = fine.v + subpixel(fine.cost(fine.u, fine.v - 1), c0, fine.cost(fine.u, fine.v + 1));
      vectors.push({ x: x + BLOCK / 2 - cx, y: y + BLOCK / 2 - cy, u, v });
    }
  }
  if (vectors.length < 4) return { tx: 0, ty: 0, zoom: 0, rot: 0, confidence: 0 };

  let fit = fitSimilarity(vectors);
  let inliers = vectors;
  for (let pass = 0; pass < 2; pass++) {
    const residual = (p: Vector) =>
      Math.hypot(p.u - (fit.tx + fit.s * p.x - fit.r * p.y), p.v - (fit.ty + fit.s * p.y + fit.r * p.x));
    const sorted = [...inliers].sort((a, b) => residual(a) - residual(b));
    inliers = sorted.slice(0, Math.max(4, Math.ceil(sorted.length * 0.7))).filter((p) => residual(p) < 2.5);
    if (inliers.length < 4) break;
    fit = fitSimilarity(inliers);
  }
  return {
    tx: fit.tx / w,
    ty: fit.ty / h,
    zoom: fit.s,
    rot: fit.r,
    confidence: textured ? inliers.length / textured : 0,
  };
}

/**
 * Estimates per-frame global motion. Frames that open a shot, and frames in `skip` (flashes),
 * get zero motion with zero confidence.
 */
export function estimateMotion(f: FrameFeatures, shotStarts: Set<number>, skip: Set<number> = new Set()): MotionSample[] {
  const samples: MotionSample[] = [{ tx: 0, ty: 0, zoom: 0, rot: 0, confidence: 0 }];
  for (let i = 1; i < f.count; i++) {
    if (shotStarts.has(i) || skip.has(i)) samples.push({ tx: 0, ty: 0, zoom: 0, rot: 0, confidence: 0 });
    else samples.push(motionBetween(f.gray[i - 1]!, f.gray[i]!, f.width, f.height));
  }
  return samples;
}
