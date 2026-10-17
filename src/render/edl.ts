import { z } from "zod";

/** Seconds, "b<n>" (the n-th tracked beat of the edit's music, fractions allowed) or "f<n>" (frame n). */
export const TimeSchema = z.union([z.number().nonnegative(), z.string().regex(/^[bf]\d+(\.\d+)?$/, 'times are seconds, "b<beat>" or "f<frame>"')]);
export type Time = z.infer<typeof TimeSchema>;

export const LOOKS = ["none", "teal-night", "cold-blue", "warm-film", "bw-contrast", "bleach", "crushed", "sepia", "neon", "dreamy"] as const;
export const EASES = ["linear", "in", "out", "inout"] as const;

const Pair = z.tuple([z.number(), z.number()]);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours are #rrggbb");

export const CameraSchema = z.object({
  /** Scale over the shot: a number (constant) or [start, end]. 1 = the fitted frame. */
  zoom: z.union([z.number().min(0.5).max(4), Pair]).optional(),
  ease: z.enum(EASES).default("out"),
  /** Total content drift over the shot as a fraction of [width, height]; +x moves content right (camera pans left). */
  pan: Pair.optional(),
  /** Roll in degrees: constant or [start, end]. */
  roll: z.union([z.number(), Pair]).optional(),
  /** Zoom kicks on hits: each adds `amount` scale that decays over `decay` seconds. */
  punch: z.object({ at: z.array(TimeSchema).min(1), amount: z.number().min(0).max(1).default(0.08), decay: z.number().positive().default(0.18) }).optional(),
  /** Shake burst between `from` and `to` (default: whole shot). `amp` is a fraction of frame width. */
  shake: z
    .object({ amp: z.number().min(0).max(0.1).default(0.012), freq: z.number().positive().default(9), from: TimeSchema.optional(), to: TimeSchema.optional(), decay: z.boolean().default(true) })
    .optional(),
  /** Slow organic drift, like a handheld camera. */
  handheld: z.object({ amp: z.number().min(0).max(0.05).default(0.004), freq: z.number().positive().default(0.7) }).optional(),
  /** Zoom focus point in the frame, [x, y] in 0–1. */
  anchor: Pair.optional(),
  /** Content offset at the start of the shot (fraction of [width, height]); `pan` drifts from here. Lets a whip land inside the shot. */
  panFrom: Pair.optional(),
  /** Exact scale for the frame instead of the automatic overscan (match a neighbouring hold; edges may show during big moves). */
  overscan: z.number().min(1).max(3).optional(),
});
export type Camera = z.infer<typeof CameraSchema>;

export const FxSchema = z.object({
  look: z.enum(LOOKS).optional(),
  /** Multipliers around 1, or offsets around 0 for exposure. */
  exposure: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(0).max(3).optional(),
  saturation: z.number().min(0).max(3).optional(),
  /** Bloom strength, 0–1, optionally tinted. */
  glow: z.number().min(0).max(1).optional(),
  glowColor: Hex.optional(),
  /** Gaussian blur at 1080p: constant, or [start, end] to blur in or out over the shot. */
  blur: z.union([z.number().min(0).max(40), z.tuple([z.number().min(0).max(40), z.number().min(0).max(40)])]).optional(),
  /** Directional blur for whips: pixels at 1080p. */
  motionBlur: z.object({ direction: z.enum(["horizontal", "vertical"]).default("horizontal"), amount: z.number().min(1).max(120) }).optional(),
  /** Radial zoom blur, 0–1. */
  zoomBlur: z.number().min(0).max(1).optional(),
  /** Chromatic split in pixels at 1080p. */
  rgbSplit: z.number().min(0).max(40).optional(),
  /** true, or an amount 0–1 for a partial invert. */
  invert: z.union([z.boolean(), z.number().min(0).max(1)]).optional(),
  bw: z.boolean().optional(),
  mirror: z.boolean().optional(),
  /** Multiply the picture toward a colour. */
  tint: z.object({ color: Hex, amount: z.number().min(0).max(1).default(0.5) }).optional(),
  /** Map shadows and highlights to two colours. */
  duotone: z.object({ shadow: Hex, highlight: Hex }).optional(),
  /** 1-bit black and white at this luminance threshold (0–1). */
  threshold: z.number().min(0).max(1).optional(),
  /** Reduce each channel to this many levels. */
  posterize: z.number().int().min(2).max(16).optional(),
  /** Keep one colour and grey out the rest (team kit, red eyes). */
  keepColor: z.object({ color: Hex, similarity: z.number().min(0.01).max(1).default(0.3), blend: z.number().min(0).max(1).default(0.1) }).optional(),
  /** Per-shot vignette, 0–1. */
  vignette: z.number().min(0).max(1).optional(),
  /** Shaped window: outside (or inside, with invert) becomes `color`. Sizes are fractions of the frame. */
  mask: z
    .object({
      shape: z.enum(["circle", "rect"]).default("circle"),
      center: Pair.default([0.5, 0.5]),
      size: Pair.default([0.6, 0.6]),
      feather: z.number().min(0).max(0.5).default(0.06),
      invert: z.boolean().default(false),
      color: Hex.default("#000000"),
      /** Animate the window over the shot: scale factor reached at the end, and where its centre ends up. */
      sizeTo: z.number().min(0.05).max(5).optional(),
      centerTo: Pair.optional(),
    })
    .optional(),
  /** Light leak washing in from one edge. */
  leak: z.object({ color: Hex.default("#FFB46A"), side: z.enum(["left", "right", "top", "bottom"]).default("left"), amount: z.number().min(0).max(1).default(0.6) }).optional(),
  /** Seconds of white flash decaying at the start / building at the end of the shot. */
  flashIn: z.number().min(0).max(1).optional(),
  flashOut: z.number().min(0).max(1).optional(),
  /** Seconds of fade from / to black at the shot edges. */
  dipIn: z.number().min(0).max(1).optional(),
  dipOut: z.number().min(0).max(1).optional(),
  /** Brightness strobe: flashes per second and strength 0–1. */
  strobe: z.object({ rate: z.number().positive().max(30), intensity: z.number().min(0).max(1).default(0.6) }).optional(),
  /** Frame-locked strobe: `on` frames of solid colour out of every `every` frames. */
  frameStrobe: z.object({ every: z.number().int().min(2).max(48), on: z.number().int().min(1).max(47).default(1), color: z.enum(["black", "white"]).default("black") }).optional(),
  /** Echo of previous frames (motion trail), 0–1. */
  trail: z.number().min(0).max(1).optional(),
});
export type Fx = z.infer<typeof FxSchema>;

export const SourceSchema = z.object({
  /** Asset id (video or still), or a colour: "black", "white", "#rrggbb". */
  asset: z.string(),
  /** Seconds into the source where the shot starts. */
  in: z.number().min(0).default(0),
  /** Playback speed; 0 freezes the frame at `in`. */
  speed: z.number().min(0).max(8).default(1),
  /** Linear speed ramp target at the end of the shot (e.g. 1 → 0.25 for a slow-motion ease). */
  speedTo: z.number().min(0.05).max(8).optional(),
  reverse: z.boolean().default(false),
  /** How to fill frames when the source is slower than the canvas: duplicate, blend or motion-interpolate. */
  interpolate: z.enum(["none", "blend", "motion"]).default("none"),
  fit: z.enum(["cover", "contain"]).default("cover"),
  /** Crop anchor for cover fit, [x, y] in 0–1. */
  focus: Pair.default([0.5, 0.5]),
  /** Subject matte clip aligned 1:1 with the source (a `matte` job's output): enables text behind the subject. */
  matte: z.string().optional(),
});

export const LAYER_BLENDS = ["normal", "screen", "add", "multiply", "overlay", "difference", "lighten", "darken"] as const;
export const LAYER_MOVES = ["none", "fade", "pop", "slide-left", "slide-right", "slide-up", "slide-down"] as const;

const LayerMoveSchema = z.object({ type: z.enum(LAYER_MOVES), duration: z.number().min(0.02).max(3).default(0.2) });

/**
 * A picture composited over the shot: a picture-in-picture card, a split-screen panel, a clone of
 * the subject (key: true), a blend-mode overlay, or a window onto the shot itself with its own
 * effects (window: true, for regional effects).
 */
export const LayerSchema = z.object({
  source: SourceSchema.default({ asset: "black", in: 0, speed: 1, reverse: false, interpolate: "none", fit: "cover", focus: [0.5, 0.5] }),
  /** [x, y, width, height] as fractions of the canvas. */
  box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).default([0, 0, 1, 1]),
  /** Timeline times; default: the whole shot. The layer's source starts at `start`. */
  start: TimeSchema.optional(),
  end: TimeSchema.optional(),
  /** Cut the subject out with `source.matte` (clones, subject over another background). */
  key: z.boolean().default(false),
  /** Show the shot's own picture (before its effects) in the box, with this layer's effects. */
  window: z.boolean().default(false),
  shape: z.enum(["rect", "circle"]).default("rect"),
  /** Soft edge for the shape, as a share of its half size. */
  feather: z.number().min(0).max(0.5).default(0),
  /** Where the box's top-left corner ends up by the layer's end (eased), to follow a moving subject. */
  boxTo: Pair.optional(),
  opacity: z.number().min(0).max(1).default(1),
  blend: z.enum(LAYER_BLENDS).default("normal"),
  /** Card border as a fraction of canvas height; `bottom` adds a deeper bottom edge (polaroid). */
  border: z.object({ width: z.number().min(0).max(0.1), color: Hex.default("#FFFFFF"), bottom: z.number().min(0).max(0.2).default(0) }).optional(),
  /** Drop shadow strength, 0–1. */
  shadow: z.number().min(0).max(1).optional(),
  enter: LayerMoveSchema.optional(),
  exit: LayerMoveSchema.optional(),
  camera: CameraSchema.optional(),
  fx: FxSchema.optional(),
});
export type Layer = z.infer<typeof LayerSchema>;

/** Repeats the shot's source in a grid (clone or mirror tiles), optionally revealed tile by tile. */
export const TileSchema = z.object({
  cols: z.number().int().min(1).max(6),
  rows: z.number().int().min(1).max(6),
  /** Mirror alternate tiles, or all of them. */
  mirror: z.enum(["none", "alternate", "all"]).default("none"),
  /** Source time offset between consecutive tiles (seconds), so the copies move out of step. */
  offset: z.number().min(-5).max(5).default(0),
  /** Seconds between tile reveals; 0 shows all at once. */
  stagger: z.number().min(0).max(2).default(0),
  /** Gap between tiles as a fraction of canvas height, filled with the shot's base picture. */
  gap: z.number().min(0).max(0.1).default(0),
  enter: z.enum(LAYER_MOVES).default("none"),
});

export const ShotSchema = z.object({
  id: z.string().optional(),
  start: TimeSchema,
  end: TimeSchema,
  source: SourceSchema,
  camera: CameraSchema.optional(),
  fx: FxSchema.optional(),
  /** Replace the background with a colour: the subject is cut out with `source.matte`. */
  background: Hex.optional(),
  tile: TileSchema.optional(),
  layers: z.array(LayerSchema).max(24).optional(),
  note: z.string().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const TEXT_ANIMS = ["none", "pop", "slam", "fade", "rise", "type", "flicker", "glitch"] as const;
export const TEXT_EXITS = ["none", "fade", "flicker", "shrink", "blur"] as const;
export const POSITIONS = ["center", "top", "bottom", "upper-third", "lower-third"] as const;

export const TextSchema = z.object({
  text: z.string().min(1),
  start: TimeSchema,
  end: TimeSchema,
  font: z.string().default("Anton"),
  /** Cap height as a fraction of canvas height. */
  size: z.number().min(0.005).max(1).default(0.1),
  /** Font weight (100–900); a static face is fetched for it. Default: the family's regular. */
  weight: z.number().int().min(100).max(900).optional(),
  opacity: z.number().min(0).max(1).default(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  outline: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"), width: z.number().min(0).max(0.3).default(0.06) }).optional(),
  shadow: z.number().min(0).max(0.2).optional(),
  glow: z.number().min(0).max(20).optional(),
  position: z.union([z.enum(POSITIONS), Pair]).default("center"),
  align: z.enum(["left", "center", "right"]).default("center"),
  /** Extra letter spacing as a fraction of the font size. */
  tracking: z.number().min(-0.2).max(2).default(0),
  anim: z.enum(TEXT_ANIMS).default("pop"),
  /** How the text leaves (default: a hard cut at `end`). */
  exit: z.enum(TEXT_EXITS).default("none"),
  uppercase: z.boolean().default(false),
  italic: z.boolean().default(false),
  /** Place the text behind the subject on shots whose source has a matte (elsewhere it stays on top). */
  behind: z.boolean().default(false),
});
export type TextEvent = z.infer<typeof TextSchema>;

export const FlashSchema = z.object({
  at: TimeSchema,
  duration: z.number().positive().max(1).default(0.08),
  /** "white", "black" or a tint such as "#F3EACD". */
  color: z.union([z.enum(["white", "black"]), Hex]).default("white"),
  intensity: z.number().min(0).max(1).default(1),
  /** Wash over the titles too, as a real flash frame does (default: titles stay readable). */
  overText: z.boolean().default(false),
});

export const SfxSchema = z.object({
  at: TimeSchema,
  /** A built-in effect (whoosh, hit, boom, riser, tick, glitch) or an audio/video asset id. */
  sound: z.string(),
  gainDb: z.number().min(-40).max(12).default(-6),
});

export const EdlSchema = z.object({
  canvas: z.object({
    width: z.number().int().min(64).max(4096),
    height: z.number().int().min(64).max(4096),
    fps: z.number().positive().max(120),
    /** Total length; defaults to the end of the last shot. */
    durationSec: z.number().positive().optional(),
  }),
  /**
   * Beat grid override: `b<n>` times follow a fixed tempo with beat 0 at `phase` seconds, instead of
   * the soundtrack's tracked beats. Use it when the edit is cut to a grid the tracker missed.
   */
  grid: z.object({ bpm: z.number().min(40).max(240), phase: z.number().min(0).default(0) }).optional(),
  /** Soundtrack: an audio/video asset (default the reference) starting `offset` seconds in. null = silent. */
  audio: z
    .object({ asset: z.string().default("ref"), offset: z.number().min(0).default(0), gainDb: z.number().min(-30).max(12).default(0), fadeOut: z.number().min(0).max(5).default(0.2) })
    .nullable()
    .default({ asset: "ref", offset: 0, gainDb: 0, fadeOut: 0.2 }),
  /** Whole-edit finish: look, grain, vignette, letterbox. */
  finish: z
    .object({
      look: z.enum(LOOKS).default("none"),
      grain: z.number().min(0).max(1).default(0),
      vignette: z.number().min(0).max(1).default(0),
      /** Letterbox bar height as a fraction of canvas height (each bar). */
      letterbox: z.number().min(0).max(0.3).default(0),
    })
    .default({ look: "none", grain: 0, vignette: 0, letterbox: 0 }),
  shots: z.array(ShotSchema).min(1),
  flashes: z.array(FlashSchema).default([]),
  text: z.array(TextSchema).default([]),
  /** Sound effects mixed under the soundtrack. */
  sfx: z.array(SfxSchema).default([]),
});
export type Edl = z.infer<typeof EdlSchema>;

export interface TimeContext {
  fps: number;
  beats: number[];
}

/** Resolves a Time to seconds on the edit timeline. Fractional beats interpolate between tracked beats. */
export function resolveTime(t: Time, ctx: TimeContext): number {
  if (typeof t === "number") return t;
  const n = Number(t.slice(1));
  if (t[0] === "f") return n / ctx.fps;
  if (!ctx.beats.length) throw new Error(`Beat time "${t}" used but the soundtrack has no tracked beats`);
  const i = Math.floor(n);
  const frac = n - i;
  const at = (k: number) => {
    if (k < ctx.beats.length) return ctx.beats[k]!;
    const period = ctx.beats.length > 1 ? (ctx.beats.at(-1)! - ctx.beats[0]!) / (ctx.beats.length - 1) : 0.5;
    return ctx.beats.at(-1)! + (k - ctx.beats.length + 1) * period;
  };
  return at(i) + frac * (at(i + 1) - at(i));
}

/** Beats of a fixed grid covering `durationSec` (plus a margin), for `Edl.grid`. */
export function gridBeats(grid: { bpm: number; phase: number }, durationSec: number): number[] {
  const period = 60 / grid.bpm;
  const out: number[] = [];
  for (let t = grid.phase; t <= durationSec + 4 * period; t += period) out.push(+t.toFixed(4));
  return out;
}

/** Frame index of a timeline time: frame f covers [f/fps, (f+1)/fps). */
export const frameAt = (sec: number, fps: number) => Math.round(sec * fps);

export interface ResolvedShot {
  index: number;
  shot: Shot;
  startSec: number;
  endSec: number;
  startFrame: number;
  frames: number;
}

export interface EdlCheck {
  totalFrames: number;
  durationSec: number;
  shots: ResolvedShot[];
  warnings: string[];
}

/** Resolves shot times to frames and reports gaps, overlaps and other problems. */
export function checkEdl(edl: Edl, ctx: TimeContext): EdlCheck {
  const fps = edl.canvas.fps;
  const warnings: string[] = [];
  const shots = edl.shots
    .map((shot, index) => {
      const startSec = resolveTime(shot.start, ctx);
      const endSec = resolveTime(shot.end, ctx);
      const startFrame = frameAt(startSec, fps);
      return { index, shot, startSec, endSec, startFrame, frames: frameAt(endSec, fps) - startFrame };
    })
    .sort((a, b) => a.startFrame - b.startFrame);
  for (const s of shots) {
    if (s.frames <= 0) warnings.push(`Shot ${s.shot.id ?? s.index} has no frames (start ${s.startSec.toFixed(3)} ≥ end ${s.endSec.toFixed(3)}).`);
  }
  let cursor = 0;
  for (const s of shots) {
    if (s.startFrame > cursor) warnings.push(`Gap of ${s.startFrame - cursor} frames before shot ${s.shot.id ?? s.index} (filled with black).`);
    if (s.startFrame < cursor) warnings.push(`Shot ${s.shot.id ?? s.index} overlaps the previous shot by ${cursor - s.startFrame} frames (later shot wins).`);
    cursor = Math.max(cursor, s.startFrame + s.frames);
  }
  const durationSec = edl.canvas.durationSec ?? cursor / fps;
  const totalFrames = frameAt(durationSec, fps);
  if (cursor < totalFrames) warnings.push(`Shots end at frame ${cursor} but the edit runs to ${totalFrames}; the tail is black.`);
  for (const t of edl.text) {
    if (resolveTime(t.end, ctx) <= resolveTime(t.start, ctx)) warnings.push(`Text "${t.text}" ends before it starts.`);
  }
  return { totalFrames, durationSec, shots: shots.filter((s) => s.frames > 0), warnings };
}
