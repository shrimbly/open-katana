import type { Camera, Fx } from "./edl.js";

/** Quotes an ffmpeg expression for use as a filter option inside a filtergraph. */
export const q = (expr: string) => `'${expr.replace(/,/g, "\\,")}'`;

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));

function ease(kind: Camera["ease"], u: string): string {
  switch (kind) {
    case "linear":
      return u;
    case "in":
      return `(${u})*(${u})`;
    case "out":
      return `(1-(1-${u})*(1-${u}))`;
    case "inout":
      return `if(lt(${u},0.5),2*(${u})*(${u}),1-2*(1-${u})*(1-${u}))`;
  }
}

export interface CameraContext {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Shot start on the timeline: camera times (punch/shake) are timeline seconds. */
  shotStartSec: number;
  /** Resolves a timeline time to seconds. */
  time: (t: number | string) => number;
}

/**
 * Builds a `perspective` filter that applies zoom, pan, roll, punches, shake and handheld drift
 * with sub-pixel sampling. The frame is over-scanned just enough that moves never reveal its edges.
 */
export function cameraFilter(cam: Camera, ctx: CameraContext): string | undefined {
  const { width: W, height: H, fps, durationSec: D } = ctx;
  const T = `(in/${n(fps)})`;
  const u = `min(max(${T}/${n(Math.max(D, 1e-3))},0),1)`;
  const e = ease(cam.ease, u);
  const parts: string[] = [];

  const [z0, z1] = Array.isArray(cam.zoom) ? cam.zoom : [cam.zoom ?? 1, cam.zoom ?? 1];
  let zoom = z0 === z1 ? n(z0) : `(${n(z0)}+${n(z1 - z0)}*${e})`;
  if (cam.punch) {
    const kicks = cam.punch.at.map((t) => {
      const local = ctx.time(t) - ctx.shotStartSec;
      return `gte(${T},${n(local)})*exp(-(${T}-${n(local)})/${n(cam.punch!.decay)})`;
    });
    zoom = `${zoom}*(1+${n(cam.punch.amount)}*(${kicks.join("+")}))`;
  }

  let dx = "0";
  let dy = "0";
  let maxShift = 0;
  const [fx0, fy0] = cam.panFrom ?? [0, 0];
  if (cam.pan || cam.panFrom) {
    const [px, py] = cam.pan ?? [0, 0];
    dx = `${n(fx0 * W)}+${n(px * W)}*${e}`;
    dy = `${n(fy0 * H)}+${n(py * H)}*${e}`;
    maxShift = Math.max(Math.abs(fx0), Math.abs(fy0), Math.abs(fx0 + px), Math.abs(fy0 + py));
  }
  if (cam.shake) {
    const s = cam.shake;
    const from = s.from !== undefined ? ctx.time(s.from) - ctx.shotStartSec : 0;
    const to = s.to !== undefined ? ctx.time(s.to) - ctx.shotStartSec : D;
    const env = `between(${T},${n(from)},${n(to)})${s.decay ? `*exp(-3*(${T}-${n(from)})/${n(Math.max(to - from, 1e-3))})` : ""}`;
    const amp = s.amp * W;
    const f = s.freq;
    dx += `+${n(amp)}*${env}*(sin(${n(2 * Math.PI * f)}*${T}+1.3)+0.6*sin(${n(2 * Math.PI * f * 1.73)}*${T}+4.1))/1.6`;
    dy += `+${n(amp * 0.8)}*${env}*(sin(${n(2 * Math.PI * f * 1.11)}*${T}+2.7)+0.6*sin(${n(2 * Math.PI * f * 2.07)}*${T}+0.4))/1.6`;
    maxShift += s.amp * 1.1;
  }
  if (cam.handheld) {
    const h = cam.handheld;
    dx += `+${n(h.amp * W)}*(sin(${n(2 * Math.PI * h.freq)}*${T}+0.5)+0.5*sin(${n(2 * Math.PI * h.freq * 2.3)}*${T}+1.9))/1.5`;
    dy += `+${n(h.amp * H)}*(sin(${n(2 * Math.PI * h.freq * 0.83)}*${T}+2.2)+0.5*sin(${n(2 * Math.PI * h.freq * 1.9)}*${T}+0.7))/1.5`;
    maxShift += h.amp;
  }

  const [r0, r1] = Array.isArray(cam.roll) ? cam.roll : [cam.roll ?? 0, cam.roll ?? 0];
  const rad = (d: number) => (d * Math.PI) / 180;
  const roll = r0 === r1 ? n(rad(r0)) : `(${n(rad(r0))}+${n(rad(r1 - r0))}*${e})`;
  const maxRoll = Math.max(Math.abs(rad(r0)), Math.abs(rad(r1)));

  const [ax, ay] = cam.anchor ?? [0.5, 0.5];
  // Overscan: a zoom ≥ 1 about an interior anchor covers the frame; translation and roll need more.
  const slack = Math.max(0.1, Math.min(ax, 1 - ax, ay, 1 - ay));
  const ratio = Math.max(W, H) / Math.min(W, H);
  const overscan = cam.overscan ?? (1 + maxShift / slack) * (Math.cos(maxRoll) + ratio * Math.sin(maxRoll));
  const identity = zoom === "1" && dx === "0" && dy === "0" && roll === "0" && overscan === 1;
  if (identity) return undefined;
  zoom = `(${zoom})*${n(overscan)}`;

  const AX = n(ax * W);
  const AY = n(ay * H);
  const corner = (cx: number, cy: number) => {
    const X = n(cx - ax * W);
    const Y = n(cy - ay * H);
    const x = `${AX}+${zoom}*((${X})*cos(${roll})-(${Y})*sin(${roll}))+${dx}`;
    const y = `${AY}+${zoom}*((${X})*sin(${roll})+(${Y})*cos(${roll}))+${dy}`;
    return [x, y];
  };
  const corners = [corner(0, 0), corner(W, 0), corner(0, H), corner(W, H)];
  corners.forEach(([x, y], i) => parts.push(`x${i}=${q(x!)}`, `y${i}=${q(y!)}`));
  return `perspective=${parts.join(":")}:sense=destination:eval=frame:interpolation=cubic`;
}

/** Grade presets as ffmpeg filter chains. */
export function lookFilters(look: Fx["look"] | undefined): string[] {
  switch (look) {
    case undefined:
    case "none":
      return [];
    case "teal-night":
      return ["colorbalance=rs=-0.12:gs=0.02:bs=0.14:rh=0.08:gh=0.02:bh=-0.08", "eq=contrast=1.12:saturation=0.85:gamma=0.95"];
    case "cold-blue":
      return ["colortemperature=temperature=8500:mix=0.7", "eq=contrast=1.08:saturation=0.8"];
    case "warm-film":
      return ["colortemperature=temperature=4600:mix=0.6", "curves=preset=vintage", "eq=saturation=0.9"];
    case "bw-contrast":
      return ["hue=s=0", "eq=contrast=1.35:gamma=0.92"];
    case "bleach":
      return ["eq=saturation=0.45:contrast=1.3:gamma=0.95"];
    case "crushed":
      return ["curves=all='0/0 0.18/0.02 0.55/0.5 1/0.96'", "eq=saturation=0.9"];
    case "sepia":
      return ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131", "eq=contrast=1.1"];
    case "neon":
      return ["eq=saturation=1.45:contrast=1.15", "colorbalance=bh=0.1:rh=0.06"];
    case "dreamy":
      return ["eq=contrast=0.92:saturation=1.1:brightness=0.03", "colortemperature=temperature=5800:mix=0.4"];
  }
}

export interface FxContext {
  width: number;
  height?: number;
  durationSec: number;
}

const hexRgb = (hex: string): [number, number, number] => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Builds a filtergraph as a sequence of stages, each reading the previous stage's label. */
class Stages {
  readonly graph: string[] = [];
  private chain: string[] = [];
  private label: string;
  private k = 0;
  constructor(input: string, private readonly prefix: string) {
    this.label = input;
  }
  add(...filters: string[]): void {
    this.chain.push(...filters);
  }
  /** A multi-branch stage: `build(input, output)` returns graph fragments. */
  branch(build: (input: string, output: string, tmp: (name: string) => string) => string[]): void {
    const input = this.flush();
    const out = `[${this.prefix}${this.k++}]`;
    this.graph.push(...build(input, out, (name) => `[${this.prefix}${this.k}${name}]`));
    this.label = out;
  }
  private flush(): string {
    if (!this.chain.length) return this.label;
    const out = `[${this.prefix}${this.k++}]`;
    this.graph.push(`${this.label}${this.chain.join(",")}${out}`);
    this.chain = [];
    this.label = out;
    return out;
  }
  end(output: string): string[] {
    if (!this.chain.length && !this.graph.length) return [`${this.label}null${output}`];
    if (this.chain.length) this.graph.push(`${this.label}${this.chain.join(",")}${output}`);
    else this.graph[this.graph.length - 1] = this.graph.at(-1)!.replace(new RegExp(`${this.label.replace(/[[\]]/g, "\\$&")}$`), output);
    return this.graph;
  }
}

/**
 * Per-shot effect chain. Returns filtergraph fragments that read [in] and write [out]; effects that
 * need several branches (glow, animated blur, zoom blur, partial invert) get their own stage.
 * `prefix` keeps labels unique when several chains share one graph (layers).
 */
export function fxGraph(fx: Fx | undefined, ctx: FxContext, input: string, output: string, prefix = "fx"): string[] {
  const st = new Stages(input, prefix);
  const scale = ctx.width / 1080;
  const D = ctx.durationSec;
  const H = ctx.height ?? Math.round((ctx.width * 9) / 16);
  if (fx?.mirror) st.add("hflip");
  if (fx?.trail) st.add(`lagfun=decay=${n(0.82 + 0.15 * fx.trail)}`);
  if (typeof fx?.blur === "number" && fx.blur > 0) st.add(`gblur=sigma=${n(fx.blur * scale)}`);
  if (Array.isArray(fx?.blur)) {
    // Blur in or out: a blurred copy fades over the picture across the shot.
    const [b0, b1] = fx.blur;
    const lo = Math.min(b0, b1);
    const hi = Math.max(b0, b1);
    if (lo > 0) st.add(`gblur=sigma=${n(lo * scale)}`);
    if (hi > lo) {
      const dir = b1 > b0 ? "in" : "out";
      st.branch((i, o, t) => [
        `${i}split${t("s")}${t("b")}`,
        `${t("b")}gblur=sigma=${n(Math.sqrt(hi * hi - lo * lo) * scale)},format=yuva420p,fade=t=${dir}:st=0:d=${n(Math.max(D, 0.04))}:alpha=1${t("f")}`,
        `${t("s")}${t("f")}overlay=format=auto${o}`,
      ]);
    }
  }
  if (fx?.motionBlur) {
    const a = Math.max(1, Math.round(fx.motionBlur.amount * scale));
    st.add(fx.motionBlur.direction === "vertical" ? `avgblur=sizeX=1:sizeY=${a}` : `avgblur=sizeX=${a}:sizeY=1`);
  }
  if (fx?.zoomBlur) {
    // Radial blur: average progressively enlarged copies about the centre.
    const copies = 6;
    const reach = 0.12 * fx.zoomBlur;
    st.branch((i, o, t) => {
      const names = Array.from({ length: copies }, (_, k) => t(`z${k}`));
      const parts = [`${i}split=${copies}${names.join("")}`];
      const scaled = names.map((nm, k) => {
        if (k === 0) return nm;
        const z = 1 + (reach * k) / (copies - 1);
        parts.push(`${nm}scale=w=${2 * Math.round((ctx.width * z) / 2)}:h=${2 * Math.round((H * z) / 2)},crop=${ctx.width}:${H}${t(`c${k}`)}`);
        return t(`c${k}`);
      });
      parts.push(`${scaled.join("")}mix=inputs=${copies}${o}`);
      return parts;
    });
  }
  st.add(...lookFilters(fx?.look));
  if (fx?.keepColor) {
    const c = fx.keepColor;
    st.add(`colorhold=color=0x${c.color.slice(1)}:similarity=${n(c.similarity)}:blend=${n(c.blend)}`);
  }
  if (fx?.bw) st.add("hue=s=0");
  if (fx?.duotone) {
    const [sr, sg, sb] = hexRgb(fx.duotone.shadow);
    const [hr, hg, hb] = hexRgb(fx.duotone.highlight);
    const ch = (lo: number, hi: number) => q(`${lo}+${hi - lo}*val/255`);
    st.add("hue=s=0", "format=rgb24", `lutrgb=r=${ch(sr, hr)}:g=${ch(sg, hg)}:b=${ch(sb, hb)}`);
  }
  if (fx?.tint) {
    const [r, g, b] = hexRgb(fx.tint.color);
    const k = fx.tint.amount;
    const m = (c: number) => n(1 - k + (k * c) / 255);
    st.add(`colorchannelmixer=rr=${m(r)}:gg=${m(g)}:bb=${m(b)}`);
  }
  if (fx?.threshold !== undefined) {
    const t = Math.round(16 + fx.threshold * 219);
    st.add("hue=s=0", `lutyuv=y=${q(`if(gte(val,${t}),235,16)`)}:u=128:v=128`);
  }
  if (fx?.posterize) {
    const L = fx.posterize;
    const p = q(`floor(val*${L}/256)*255/${L - 1}`);
    st.add("format=rgb24", `lutrgb=r=${p}:g=${p}:b=${p}`);
  }
  if (fx?.invert === true || fx?.invert === 1) st.add("negate");
  else if (typeof fx?.invert === "number" && fx.invert > 0) {
    const a = fx.invert;
    st.branch((i, o, t) => [`${i}split${t("a")}${t("b")}`, `${t("b")}negate${t("n")}`, `${t("n")}${t("a")}blend=all_mode=normal:all_opacity=${n(a)}${o}`]);
  }

  const bright: string[] = [];
  if (fx?.exposure) bright.push(n(fx.exposure));
  if (fx?.flashIn) bright.push(`if(lt(t,${n(fx.flashIn)}),1-t/${n(fx.flashIn)},0)`);
  if (fx?.flashOut) bright.push(`if(gt(t,${n(D - fx.flashOut)}),(t-${n(D - fx.flashOut)})/${n(fx.flashOut)},0)`);
  if (fx?.dipIn) bright.push(`-if(lt(t,${n(fx.dipIn)}),1-t/${n(fx.dipIn)},0)`);
  if (fx?.dipOut) bright.push(`-if(gt(t,${n(D - fx.dipOut)}),(t-${n(D - fx.dipOut)})/${n(fx.dipOut)},0)`);
  if (fx?.strobe) bright.push(`${n(fx.strobe.intensity)}*gt(sin(${n(2 * Math.PI * fx.strobe.rate)}*t),0.5)`);
  const eqParts: string[] = [];
  if (bright.length) eqParts.push(`brightness=${q(bright.join("+").replace(/\+-/g, "-"))}`);
  if (fx?.contrast !== undefined) eqParts.push(`contrast=${n(fx.contrast)}`);
  if (fx?.saturation !== undefined) eqParts.push(`saturation=${n(fx.saturation)}`);
  if (eqParts.length) st.add(`eq=${eqParts.join(":")}:eval=frame`);
  if (fx?.rgbSplit) {
    const k = Math.max(1, Math.round(fx.rgbSplit * scale));
    st.add(`rgbashift=rh=${-k}:bh=${k}:edge=smear`);
  }
  if (fx?.glow) {
    const glow = fx.glow;
    const tint = fx.glowColor ? hexRgb(fx.glowColor) : undefined;
    // Screen blending only means something in RGB: in YUV it lifts the chroma planes toward magenta.
    st.branch((i, o, t) => [
      `${i}format=gbrp,split${t("base")}${t("src")}`,
      `${t("src")}gblur=sigma=${n(18 * scale)},colorlevels=romin=0.04:gomin=0.04:bomin=0.04${tint ? `,colorchannelmixer=rr=${n(tint[0] / 255)}:gg=${n(tint[1] / 255)}:bb=${n(tint[2] / 255)}` : ""}${t("blur")}`,
      `${t("base")}${t("blur")}blend=all_mode=screen:all_opacity=${n(Math.min(1, glow))}${o}`,
    ]);
  }
  if (fx?.vignette) st.add(`vignette=a=${n(0.25 + 0.5 * fx.vignette)}`);
  if (fx?.frameStrobe) {
    const f = fx.frameStrobe;
    st.add(`drawbox=x=0:y=0:w=iw:h=ih:color=${f.color}:t=fill:enable=${q(`lt(mod(n,${f.every}),${Math.min(f.on, f.every - 1)})`)}`);
  }
  return st.end(output);
}
