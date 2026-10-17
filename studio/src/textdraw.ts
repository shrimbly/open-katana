import type { TextT } from "./api.js";

/**
 * Draws text events the way the renderer's ASS output does (src/render/ass.ts), so edits preview
 * live over the picture. Coordinates are the canvas' script space (edit width × height).
 */

const CAP_RATIO = 0.7;

export interface FontMetrics {
  unitsPerEm: number;
  winAscent: number;
  winDescent: number;
  capHeight: number;
}

const metrics = new Map<string, FontMetrics>();

/** Registers a family's file metrics (from the server), so sizes match libass exactly. */
export function setFontMetrics(family: string, m: FontMetrics): void {
  metrics.set(family, m);
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  fs: number;
  em: number;
  lines: string[];
  widths: number[];
  ascent: number;
  lineHeight: number;
  anchor: { x: number; y: number };
  box: Box;
  align: "left" | "center" | "right";
}

const cellCache = new Map<string, number>();

/** libass sizes a font so ascent + descent equals \fs; returns that cell height per em for a family. */
function cellPerEm(ctx: CanvasRenderingContext2D, family: string): number {
  const hit = cellCache.get(family);
  if (hit) return hit;
  ctx.save();
  ctx.font = `100px "${family}"`;
  const m = ctx.measureText("Hg");
  ctx.restore();
  const cell = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100 || 1.2;
  if (document.fonts.check(`12px "${family}"`)) cellCache.set(family, cell);
  return cell;
}

export function forgetMetrics(): void {
  cellCache.clear();
}

function fontString(t: TextT, em: number): string {
  return `${t.italic ? "italic " : ""}${t.weight ?? 400} ${em.toFixed(2)}px "${t.font}", sans-serif`;
}

const supportsSpacing = typeof CanvasRenderingContext2D !== "undefined" && "letterSpacing" in CanvasRenderingContext2D.prototype;

function setFont(ctx: CanvasRenderingContext2D, t: TextT, em: number, fs: number): void {
  ctx.font = fontString(t, em);
  if (supportsSpacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(t.tracking * fs).toFixed(2)}px`;
}

function measure(ctx: CanvasRenderingContext2D, s: string, t: TextT, fs: number): number {
  const w = ctx.measureText(s).width;
  return supportsSpacing ? w : w + [...s].length * t.tracking * fs;
}

function drawRun(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, t: TextT, fs: number, mode: "fill" | "stroke"): void {
  if (supportsSpacing || !t.tracking) {
    if (mode === "fill") ctx.fillText(s, x, y);
    else ctx.strokeText(s, x, y);
    return;
  }
  let cx = x;
  for (const ch of s) {
    if (mode === "fill") ctx.fillText(ch, cx, y);
    else ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + t.tracking * fs;
  }
}

/** The anchor point and alignment the renderer uses for a position. */
function anchorFor(t: TextT, W: number, H: number): { x: number; y: number; v: "top" | "middle" | "bottom" } {
  if (Array.isArray(t.position)) return { x: t.position[0] * W, y: t.position[1] * H, v: "middle" };
  const x = t.align === "left" ? Math.round(W * 0.06) : t.align === "right" ? Math.round(W * 0.94) : Math.round(W / 2);
  switch (t.position) {
    case "top":
      return { x, y: Math.round(H * 0.07), v: "top" };
    case "bottom":
      return { x, y: Math.round(H * 0.93), v: "bottom" };
    case "upper-third":
      return { x, y: Math.round(H / 3), v: "middle" };
    case "lower-third":
      return { x, y: Math.round((2 * H) / 3), v: "middle" };
    default:
      return { x, y: Math.round(H / 2), v: "middle" };
  }
}

export function displayText(t: TextT): string {
  return t.uppercase ? t.text.toUpperCase() : t.text;
}

export function layout(ctx: CanvasRenderingContext2D, t: TextT, W: number, H: number): Layout {
  const m = metrics.get(t.font);
  // libass scales a font so win ascent + descent equals the ASS size; `size` is the cap height.
  const cellUnits = m ? m.winAscent + m.winDescent : 0;
  const fs = Math.round((t.size * H) / (m ? m.capHeight / cellUnits : CAP_RATIO));
  const em = m ? (fs * m.unitsPerEm) / cellUnits : fs / cellPerEm(ctx, t.font);
  ctx.save();
  setFont(ctx, t, em, fs);
  const lines = displayText(t).split(/\r?\n/);
  const widths = lines.map((l) => measure(ctx, l, t, fs));
  const box = ctx.measureText("Hg");
  ctx.restore();
  const lineHeight = fs;
  const ascent = m ? (fs * m.winAscent) / cellUnits : (box.fontBoundingBoxAscent / (box.fontBoundingBoxAscent + box.fontBoundingBoxDescent || 1)) * fs;
  const w = Math.max(...widths, 1);
  const h = lines.length * lineHeight;
  const a = anchorFor(t, W, H);
  const x = t.align === "left" ? a.x : t.align === "right" ? a.x - w : a.x - w / 2;
  const y = a.v === "top" ? a.y : a.v === "bottom" ? a.y - h : a.y - h / 2;
  return { fs, em, lines, widths, ascent, lineHeight, anchor: { x: a.x, y: a.y }, box: { x, y, w, h }, align: t.align };
}

interface AnimState {
  alpha: number;
  scale: number;
  dy: number;
  /** For the typewriter: how many characters are visible. */
  chars?: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k));

/** Mirrors the override tags in ass.ts for time `ms` into an event lasting `durMs`. */
export function animState(t: TextT, ms: number, durMs: number, H: number): AnimState {
  const fad = (inMs: number, outMs: number) => Math.min(inMs > 0 ? ms / inMs : 1, outMs > 0 ? (durMs - ms) / outMs : 1, 1);
  switch (t.anim) {
    case "pop":
      return { alpha: fad(0, Math.min(80, durMs / 4) | 0), scale: lerp(1.35, 1, ms / 120), dy: 0 };
    case "slam":
      return { alpha: lerp(0, 1, ms / 60), scale: ms < 90 ? lerp(2.5, 0.92, ms / 90) : lerp(0.92, 1, (ms - 90) / 60), dy: 0 };
    case "fade": {
      const f = Math.min(180, durMs / 3) | 0;
      return { alpha: fad(f, f), scale: 1, dy: 0 };
    }
    case "rise":
      return { alpha: fad(120, 120), scale: 1, dy: lerp(H * 0.05, 0, ms / 220) };
    case "flicker": {
      const on = ms >= 230 || (ms >= 120 && ms < 200) || (ms >= 40 && ms < 80);
      return { alpha: on ? 1 : 0, scale: 1, dy: 0 };
    }
    case "type": {
      const n = [...displayText(t)].length;
      const step = Math.min(60, (durMs * 0.6) / Math.max(1, n));
      return { alpha: 1, scale: 1, dy: 0, chars: Math.min(n, Math.floor(ms / step) + 1) };
    }
    default:
      return { alpha: 1, scale: 1, dy: 0 };
  }
}

/** Exit effects (ass.ts exitTags) at `ms` into an event lasting `durMs`. */
function exitState(t: TextT, ms: number, durMs: number): { alpha: number; scale: number; blur: number } {
  const left = durMs - ms;
  const fade = (len: number) => (len > 0 ? Math.min(1, Math.max(0, left / len)) : 1);
  switch (t.exit) {
    case "fade":
      return { alpha: fade(Math.min(220, durMs / 3) | 0), scale: 1, blur: 0 };
    case "flicker":
      return { alpha: (left <= 130 && left > 90) || left <= 50 ? 0 : 1, scale: 1, blur: 0 };
    case "shrink":
      return { alpha: fade(Math.min(140, durMs / 3) | 0), scale: left < 140 ? lerp(0.2, 1, left / 140) : 1, blur: 0 };
    case "blur":
      return { alpha: fade(Math.min(180, durMs / 3) | 0), scale: 1, blur: left < 180 ? lerp(24, 0, left / 180) : 0 };
    default:
      return { alpha: 1, scale: 1, blur: 0 };
  }
}

/** The renderer's deterministic glitch jitter (ass.ts). */
function jitter(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const GLITCH_MS = 240;

let glowBuffer: HTMLCanvasElement | undefined;
function glowCanvas(w: number, h: number): HTMLCanvasElement {
  glowBuffer ??= document.createElement("canvas");
  if (glowBuffer.width !== w || glowBuffer.height !== h) {
    glowBuffer.width = w;
    glowBuffer.height = h;
  }
  return glowBuffer;
}

/**
 * Draws one text event at `ms` into its lifetime (it started at `startSec` on the timeline);
 * returns its layout for hit testing.
 */
export function drawText(ctx: CanvasRenderingContext2D, t: TextT, ms: number, durMs: number, W: number, H: number, pxScale: number, startSec = 0): Layout {
  const L = layout(ctx, t, W, H);
  const glitchMs = Math.min(GLITCH_MS, durMs);
  if (t.anim === "glitch" && ms < glitchMs) {
    drawGlitch(ctx, t, L, ms, glitchMs, W, H, startSec);
    return L;
  }
  const st = t.anim === "glitch" ? { alpha: 1, scale: 1, dy: 0 } : animState(t, ms, durMs, H);
  const ex = exitState(t, ms, durMs);
  const alpha = Math.min(st.alpha, ex.alpha) * t.opacity;
  if (alpha <= 0.001) return L;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ex.blur) ctx.filter = `blur(${(ex.blur * 0.85 * pxScale).toFixed(2)}px)`;
  ctx.translate(L.anchor.x, L.anchor.y + st.dy);
  ctx.scale(st.scale * ex.scale, st.scale * ex.scale);
  ctx.translate(-L.anchor.x, -L.anchor.y);
  setFont(ctx, t, L.em, L.fs);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // Each line is drawn from its own left edge so the typewriter reveal never shifts the layout.
  let remaining = st.chars ?? Number.POSITIVE_INFINITY;
  const runs = L.lines.map((line, i) => {
    const x = L.align === "left" ? L.box.x : L.align === "right" ? L.box.x + L.box.w - L.widths[i]! : L.box.x + (L.box.w - L.widths[i]!) / 2;
    const y = L.box.y + i * L.lineHeight + L.ascent;
    const chars = [...line];
    const shown = chars.slice(0, Math.max(0, Math.min(chars.length, remaining))).join("");
    remaining -= chars.length + 1;
    return { x, y, s: shown };
  });
  const bord = t.outline ? t.outline.width * L.fs : 0;
  const pass = (fill: string, stroke: string | null, dx: number, dy: number, strokeWidth: number) => {
    for (const r of runs) {
      if (!r.s) continue;
      if (stroke && strokeWidth > 0) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth * 2;
        drawRun(ctx, r.s, r.x + dx, r.y + dy, t, L.fs, "stroke");
      }
      ctx.fillStyle = fill;
      drawRun(ctx, r.s, r.x + dx, r.y + dy, t, L.fs, "fill");
    }
  };

  if (t.glow) {
    // The glow layer is one translucent shape (fill + a thin border), blurred as a whole: draw it
    // opaque off-screen, then composite at the layer's opacity so overlaps don't double up.
    const g = glowCanvas(ctx.canvas.width, ctx.canvas.height);
    const gc = g.getContext("2d")!;
    gc.setTransform(1, 0, 0, 1, 0, 0);
    gc.clearRect(0, 0, g.width, g.height);
    gc.setTransform(ctx.getTransform());
    gc.font = ctx.font;
    if (supportsSpacing) (gc as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing;
    gc.lineJoin = "round";
    gc.textBaseline = "alphabetic";
    for (const r of runs) {
      if (!r.s) continue;
      gc.strokeStyle = t.color;
      gc.lineWidth = L.fs * 0.045 * 2;
      drawRun(gc, r.s, r.x, r.y, t, L.fs, "stroke");
      gc.fillStyle = t.color;
      drawRun(gc, r.s, r.x, r.y, t, L.fs, "fill");
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // libass turns \blur b into a Gaussian with sigma ≈ 0.85·b; the renderer uses \blur = 3 × glow.
    ctx.filter = `blur(${((t.glow * 3 + ex.blur) * 0.85 * pxScale).toFixed(2)}px)`;
    ctx.globalAlpha = alpha * 0.62;
    ctx.drawImage(g, 0, 0);
    ctx.restore();
  }
  if (t.shadow) {
    const off = t.shadow * L.fs;
    pass("rgba(0,0,0,0.5)", "rgba(0,0,0,0.5)", off, off, bord);
  }
  pass(t.color, t.outline ? t.outline.color : null, 0, 0, bord);
  ctx.restore();
  return L;
}

/** The glitch entrance: jittered copies with red and cyan ghosts split either side (ass.ts). */
function drawGlitch(ctx: CanvasRenderingContext2D, t: TextT, L: Layout, ms: number, glitchMs: number, W: number, H: number, startSec: number): void {
  const rand = jitter(`${t.text}${+startSec.toFixed(6)}`);
  const steps = 6;
  const step = Math.min(steps - 1, Math.floor(ms / (glitchMs / steps)));
  let dx = 0;
  let dy = 0;
  let split = 0;
  for (let i = 0; i <= step; i++) {
    dx = Math.round((rand() - 0.5) * 0.05 * W * (1 - i / steps));
    dy = Math.round((rand() - 0.5) * 0.012 * H);
    split = Math.round((0.004 + rand() * 0.01) * W);
  }
  ctx.save();
  setFont(ctx, t, L.em, L.fs);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const draw = (color: string, alpha: number, off: number) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    L.lines.forEach((line, i) => {
      const x = L.align === "left" ? L.box.x : L.align === "right" ? L.box.x + L.box.w - L.widths[i]! : L.box.x + (L.box.w - L.widths[i]!) / 2;
      drawRun(ctx, line, x + dx + off, L.box.y + i * L.lineHeight + L.ascent + dy, t, L.fs, "fill");
    });
  };
  draw("#FF0040", 0.75 * t.opacity, split);
  draw("#00FFFF", 0.75 * t.opacity, -split);
  if (step % 3 !== 1) draw(t.color, t.opacity, 0);
  ctx.restore();
}

/** The on-screen box of a text after its entrance animation has settled. */
export function settledBox(ctx: CanvasRenderingContext2D, t: TextT, W: number, H: number): Box {
  return layout(ctx, t, W, H).box;
}
