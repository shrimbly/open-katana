import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/proc.js";
import type { Fx, Layer, Shot } from "./edl.js";
import { q } from "./expr.js";

/** Helpers for layered compositing: generated mattes, tile layouts and layer motion. */

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
export const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

const hexRgb = (hex: string): [number, number, number] => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Renders a still with ffmpeg's geq once and caches it by its parameters. */
async function generated(cacheDir: string, w: number, h: number, format: "gray" | "gbrp", exprs: string): Promise<string> {
  const key = createHash("sha1").update(JSON.stringify({ w, h, format, exprs })).digest("hex").slice(0, 16);
  const dir = join(cacheDir, "gen");
  const file = join(dir, `${key}.png`);
  if (existsSync(file)) return file;
  await mkdir(dir, { recursive: true });
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:d=0.04`, "-frames:v", "1", "-vf", `format=${format},geq=${exprs}`, file]);
  return file;
}

export interface ShapeSpec {
  shape: "circle" | "rect";
  /** Centre in pixels. */
  cx: number;
  cy: number;
  /** Half extents in pixels (circle: rx = ry). */
  rx: number;
  ry: number;
  /** Soft edge as a fraction of the half extent. */
  feather: number;
  invert?: boolean;
}

/** A grey matte: white inside the shape, black outside (or the reverse with invert). */
export function shapeMatte(cacheDir: string, w: number, h: number, s: ShapeSpec): Promise<string> {
  const d =
    s.shape === "circle"
      ? `hypot((X-${n(s.cx)})/${n(s.rx)},(Y-${n(s.cy)})/${n(s.ry)})`
      : `max(abs(X-${n(s.cx)})/${n(s.rx)},abs(Y-${n(s.cy)})/${n(s.ry)})`;
  const inside = s.feather > 0 ? `clip((1-${d})/${n(s.feather)},0,1)` : `lte(${d},1)`;
  const v = s.invert ? `255*(1-${inside})` : `255*${inside}`;
  return generated(cacheDir, w, h, "gray", `lum=${q(v)}`);
}

/** The shape matte for an fx.mask on a w×h frame. */
export function maskSpec(mask: NonNullable<Fx["mask"]>, w: number, h: number): ShapeSpec {
  const [cx, cy] = mask.center;
  const [sw, sh] = mask.size;
  if (mask.shape === "circle") {
    // Circles are round on any frame: the diameter is a share of the frame's shorter side.
    const r = (sw * Math.min(w, h)) / 2;
    return { shape: "circle", cx: cx * w, cy: cy * h, rx: r, ry: r, feather: mask.feather, invert: mask.invert };
  }
  return { shape: "rect", cx: cx * w, cy: cy * h, rx: (sw * w) / 2, ry: (sh * h) / 2, feather: mask.feather, invert: mask.invert };
}

/** A coloured light leak falling off from one edge, to be screen-blended over the picture. */
export function leakImage(cacheDir: string, w: number, h: number, leak: NonNullable<Fx["leak"]>): Promise<string> {
  const [r, g, b] = hexRgb(leak.color);
  const reach = 0.7;
  const dist = { left: `X/${w}`, right: `(${w}-X)/${w}`, top: `Y/${h}`, bottom: `(${h}-Y)/${h}` }[leak.side];
  const across = leak.side === "left" || leak.side === "right" ? `(Y-${h / 2})/${h / 2}` : `(X-${w / 2})/${w / 2}`;
  const v = `${n(leak.amount)}*pow(clip(1-${dist}/${reach},0,1),2)*(1-0.35*pow(${across},2))`;
  return generated(cacheDir, w, h, "gbrp", `r=${q(`${r}*${v}`)}:g=${q(`${g}*${v}`)}:b=${q(`${b}*${v}`)}`);
}

/** Expands a shot's tile grid into layers. */
export function tileLayers(shot: Shot, canvasW: number, canvasH: number, shotStartSec: number): Layer[] {
  const t = shot.tile;
  if (!t) return [];
  const gx = (t.gap * canvasH) / canvasW;
  const gy = t.gap;
  const cw = (1 - gx * (t.cols + 1)) / t.cols;
  const ch = (1 - gy * (t.rows + 1)) / t.rows;
  const out: Layer[] = [];
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      const i = r * t.cols + c;
      const mirror = t.mirror === "all" || (t.mirror === "alternate" && (r + c) % 2 === 1);
      out.push({
        source: { ...shot.source, in: Math.max(0, shot.source.in + i * t.offset), matte: undefined },
        box: [gx + c * (cw + gx), gy + r * (ch + gy), cw, ch],
        start: t.stagger > 0 ? +(shotStartSec + i * t.stagger).toFixed(4) : undefined,
        key: false,
        window: false,
        shape: "rect",
        feather: 0,
        opacity: 1,
        blend: "normal",
        enter: t.enter !== "none" ? { type: t.enter, duration: 0.15 } : undefined,
        fx: mirror ? { mirror: true } : undefined,
      });
    }
  }
  return out;
}

/** Colour a blend-mode layer is padded with so it leaves the picture unchanged outside the layer. */
export function neutralFor(blend: Layer["blend"]): string {
  switch (blend) {
    case "multiply":
    case "darken":
      return "white";
    case "overlay":
      return "0x808080";
    default:
      return "black";
  }
}

const easeOut = (p: string) => `(1-pow(1-${p},3))`;

/** Crop offset expressions for a window layer whose box travels (segment time t). */
export function windowCrop(layer: Layer, bx: number, by: number, W: number, H: number, a: number, b: number): { x: string; y: string } {
  if (!layer.boxTo) return { x: n(bx), y: n(by) };
  const u = `clip((t-${n(a)})/${n(Math.max(b - a, 1e-3))},0,1)`;
  const e = `if(lt(${u},0.5),2*${u}*${u},1-2*(1-${u})*(1-${u}))`;
  return { x: `${n(bx)}+${n(layer.boxTo[0] * W - bx)}*${e}`, y: `${n(by)}+${n(layer.boxTo[1] * H - by)}*${e}` };
}

export interface Placement {
  /** Overlay x/y expressions (main frame W×H, layer w×h). */
  x: string;
  y: string;
  /** Scale expression for "pop" moves (1 = full size), or undefined. */
  scale?: string;
}

/**
 * Overlay position (and pop scale) for a layer over [a, b] seconds of the segment, with its
 * enter and exit moves.
 */
export function placement(layer: Layer, bx: number, by: number, bw: number, bh: number, W: number, H: number, a: number, b: number): Placement {
  const offs: { x: string[]; y: string[]; s: string[] } = { x: [], y: [], s: [] };
  const move = (m: Layer["enter"], entering: boolean) => {
    if (!m || m.type === "none" || m.type === "fade") return;
    const d = Math.max(0.02, Math.min(m.duration, (b - a) / (layer.enter && layer.exit ? 2 : 1)));
    // Progress of the move: 1 → 0 while entering (offset shrinks), 0 → 1 while leaving.
    const p = entering ? `(1-${easeOut(`clip((t-${n(a)})/${n(d)},0,1)`)})` : `pow(clip((t-${n(b - d)})/${n(d)},0,1),3)`;
    switch (m.type) {
      case "slide-left":
        offs.x.push(`${n(entering ? W - bx : -(bx + bw))}*${p}`);
        break;
      case "slide-right":
        offs.x.push(`${n(entering ? -(bx + bw) : W - bx)}*${p}`);
        break;
      case "slide-up":
        offs.y.push(`${n(entering ? H - by : -(by + bh))}*${p}`);
        break;
      case "slide-down":
        offs.y.push(`${n(entering ? -(by + bh) : H - by)}*${p}`);
        break;
      case "pop":
        if (entering) {
          const u = `clip((t-${n(a)})/${n(d)},0,1)`;
          offs.s.push(`if(lt(${u},0.7),0.35+0.73*${u}/0.7,1.08-0.08*(${u}-0.7)/0.3)`);
        } else offs.s.push(`(1-0.92*${p})`);
        break;
    }
  };
  move(layer.enter, true);
  move(layer.exit, false);
  if (layer.boxTo) {
    // Travel to boxTo across the layer's life, easing in and out.
    const u = `clip((t-${n(a)})/${n(Math.max(b - a, 1e-3))},0,1)`;
    const e = `if(lt(${u},0.5),2*${u}*${u},1-2*(1-${u})*(1-${u}))`;
    offs.x.push(`${n(layer.boxTo[0] * W - bx)}*${e}`);
    offs.y.push(`${n(layer.boxTo[1] * H - by)}*${e}`);
  }
  const scale = offs.s.length ? offs.s.join("*") : undefined;
  const cx = scale ? `+(${n(bw)}-w)/2` : "";
  const cy = scale ? `+(${n(bh)}-h)/2` : "";
  return {
    x: `${n(bx)}${cx}${offs.x.map((o) => `+${o}`).join("")}`,
    y: `${n(by)}${cy}${offs.y.map((o) => `+${o}`).join("")}`,
    scale,
  };
}
