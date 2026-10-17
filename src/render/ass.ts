import type { TextEvent } from "./edl.js";

/** Fallback cap height as a share of the ASS font size, for fonts whose metrics are unknown. */
const CAP_RATIO = 0.7;

/** ASS colours are &HAABBGGRR. */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}&`.toUpperCase();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Strips ASS control characters from user text; "\n" becomes a hard line break. */
export function assText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "").replace(/\r?\n/g, "\\N");
}

interface Placement {
  an: number;
  x: number;
  y: number;
}

function placement(t: TextEvent, W: number, H: number): Placement {
  const horiz = t.align === "left" ? 0 : t.align === "right" ? 2 : 1;
  if (Array.isArray(t.position)) {
    return { an: 4 + horiz, x: Math.round(t.position[0] * W), y: Math.round(t.position[1] * H) };
  }
  const xs = [Math.round(W * 0.06), Math.round(W / 2), Math.round(W * 0.94)];
  const x = xs[horiz]!;
  switch (t.position) {
    case "top":
      return { an: 7 + horiz, x, y: Math.round(H * 0.07) };
    case "bottom":
      return { an: 1 + horiz, x, y: Math.round(H * 0.93) };
    case "upper-third":
      return { an: 4 + horiz, x, y: Math.round(H / 3) };
    case "lower-third":
      return { an: 4 + horiz, x, y: Math.round((2 * H) / 3) };
    default:
      return { an: 4 + horiz, x, y: Math.round(H / 2) };
  }
}

const alphaHex = (opacity: number) => `&H${Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;

interface Alphas {
  /** Tags that make the line visible at its resting opacity, and fully hidden. */
  show: string;
  hide: string;
}

/**
 * Alpha tags per line kind. Glow layers keep their fill transparent, so they animate only the
 * border channel (\\3a); text lines set fill, border and shadow separately so animations never
 * turn a translucent shadow opaque.
 */
function alphas(t: TextEvent, glow: boolean): Alphas {
  if (glow) return { show: `\\3a${alphaHex(t.opacity * (1 - 0x60 / 255))}`, hide: "\\3a&HFF&" };
  const a = alphaHex(t.opacity);
  return { show: `\\1a${a}\\3a${a}\\4a${alphaHex(t.opacity * 0.5)}`, hide: "\\1a&HFF&\\3a&HFF&\\4a&HFF&" };
}

/** Entrance override tags, plus the fade the entrance wants (ms in, ms out). */
function animTags(t: TextEvent, p: Placement, H: number, durMs: number, al: Alphas): { tags: string; positioned: boolean; fadeIn: number; fadeOut: number } {
  const { show, hide } = al;
  switch (t.anim) {
    case "pop":
      return { tags: "\\fscx135\\fscy135\\t(0,120,\\fscx100\\fscy100)", positioned: false, fadeIn: 0, fadeOut: Math.min(80, durMs / 4) | 0 };
    case "slam":
      return { tags: `\\fscx250\\fscy250${hide}\\t(0,60,${show})\\t(0,90,\\fscx92\\fscy92)\\t(90,150,\\fscx100\\fscy100)`, positioned: false, fadeIn: 0, fadeOut: 0 };
    case "fade": {
      const f = Math.min(180, durMs / 3) | 0;
      return { tags: "", positioned: false, fadeIn: f, fadeOut: f };
    }
    case "rise": {
      const dy = Math.round(H * 0.05);
      return { tags: `\\move(${p.x},${p.y + dy},${p.x},${p.y},0,220)`, positioned: true, fadeIn: 120, fadeOut: 120 };
    }
    case "flicker":
      return { tags: `\\t(0,1,${hide})\\t(40,41,${show})\\t(80,81,${hide})\\t(120,121,${show})\\t(200,201,${hide})\\t(230,231,${show})`, positioned: false, fadeIn: 0, fadeOut: 0 };
    default:
      return { tags: "", positioned: false, fadeIn: 0, fadeOut: 0 };
  }
}

/** Exit override tags for a line lasting durMs, and the fade-out the exit wants. */
function exitTags(t: TextEvent, durMs: number, al: Alphas): { tags: string; fadeOut: number } {
  const at = (ms: number) => Math.max(0, durMs - ms);
  switch (t.exit) {
    case "fade":
      return { tags: "", fadeOut: Math.min(220, durMs / 3) | 0 };
    case "flicker":
      return { tags: `\\t(${at(130)},${at(129)},${al.hide})\\t(${at(90)},${at(89)},${al.show})\\t(${at(50)},${at(49)},${al.hide})`, fadeOut: 0 };
    case "shrink":
      return { tags: `\\t(${at(140)},${durMs},\\fscx20\\fscy20)`, fadeOut: Math.min(140, durMs / 3) | 0 };
    case "blur":
      return { tags: `\\t(${at(180)},${durMs},\\blur24)`, fadeOut: Math.min(180, durMs / 3) | 0 };
    default:
      return { tags: "", fadeOut: 0 };
  }
}

/** Deterministic jitter for glitch entrances. */
function jitter(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export interface AssEvent {
  layer: number;
  start: number;
  end: number;
  text: string;
}

/** Duration of the glitch entrance, seconds. */
export const GLITCH_SEC = 0.24;

/**
 * Converts resolved text events into ASS dialogue lines (glow layers sit behind the text).
 * `capRatio` gives each family's cap height as a share of its ASS font size, so `size` is the real
 * cap height on screen.
 */
export function textToAss(events: { event: TextEvent; startSec: number; endSec: number }[], W: number, H: number, capRatio: (family: string) => number = () => CAP_RATIO): string {
  const lines: AssEvent[] = [];
  for (const { event: t, startSec, endSec } of events) {
    const fs = Math.round((t.size * H) / capRatio(t.font));
    const p = placement(t, W, H);
    const textAl = alphas(t, false);
    const glowAl = alphas(t, true);
    const style = [
      `\\an${p.an}`,
      `\\fn${t.font}`,
      `\\fs${fs}`,
      `\\fsp${(t.tracking * fs).toFixed(1)}`,
      t.weight ? `\\b${t.weight}` : "",
      t.italic ? "\\i1" : "",
      `\\1c${assColor(t.color)}`,
      t.outline ? `\\bord${(t.outline.width * fs).toFixed(1)}\\3c${assColor(t.outline.color)}` : "\\bord0",
      t.shadow ? `\\shad${(t.shadow * fs).toFixed(1)}\\4c&H000000&` : "\\shad0",
    ].join("");
    const body = assText(t.uppercase ? t.text.toUpperCase() : t.text);

    /** One dialogue line from `start` to `end`: entrance from `entrance`, exit if it ends the event. */
    const line = (layer: number, start: number, end: number, text: string, opts: { glow?: boolean; entrance?: boolean; pos?: [number, number]; extra?: string } = {}) => {
      const al = opts.glow ? glowAl : textAl;
      const durMs = Math.round((end - start) * 1000);
      const enter = opts.entrance === false ? { tags: "", positioned: false, fadeIn: 0, fadeOut: 0 } : animTags(t, p, H, Math.round((endSec - startSec) * 1000), al);
      const ends = Math.abs(end - endSec) < 1e-6;
      const exit = ends ? exitTags(t, durMs, al) : { tags: "", fadeOut: 0 };
      const fadeIn = enter.fadeIn;
      const fadeOut = ends ? Math.max(exit.fadeOut, enter.fadeOut) : 0;
      const pos = opts.pos ? `\\pos(${opts.pos[0]},${opts.pos[1]})` : enter.positioned ? "" : `\\pos(${p.x},${p.y})`;
      const fad = fadeIn || fadeOut ? `\\fad(${fadeIn},${fadeOut})` : "";
      lines.push({ layer, start, end, text: `{${style}${pos}${al.show}${opts.extra ?? ""}${enter.tags}${exit.tags}${fad}}${text}` });
    };

    if (t.anim === "type") {
      // Typewriter: reveal one character at a time, keeping hidden characters transparent so layout never shifts.
      const chars = [...body.replace(/\\N/g, "\n")];
      const step = Math.min(0.06, ((endSec - startSec) * 0.6) / Math.max(1, chars.length));
      chars.forEach((_, i) => {
        const s = startSec + i * step;
        const e = i === chars.length - 1 ? endSec : startSec + (i + 1) * step;
        const shown = chars.slice(0, i + 1).join("").replace(/\n/g, "\\N");
        const hidden = chars.slice(i + 1).join("").replace(/\n/g, "\\N");
        line(1, s, e, `${shown}${hidden ? `{\\alpha&HFF&}${hidden}` : ""}`, { entrance: false });
      });
      continue;
    }

    let settle = startSec;
    if (t.anim === "glitch") {
      // Glitch: a few frames of jittered position with red and cyan copies split either side.
      const rand = jitter(`${t.text}${+startSec.toFixed(6)}`);
      const steps = 6;
      const end = Math.min(endSec, startSec + GLITCH_SEC);
      const step = (end - startSec) / steps;
      for (let i = 0; i < steps; i++) {
        const s = startSec + i * step;
        const e = s + step;
        const dx = Math.round((rand() - 0.5) * 0.05 * W * (1 - i / steps));
        const dy = Math.round((rand() - 0.5) * 0.012 * H);
        const split = Math.round((0.004 + rand() * 0.01) * W);
        const pos: [number, number] = [p.x + dx, p.y + dy];
        const ghost = (color: string, off: number) =>
          lines.push({ layer: 2, start: s, end: e, text: `{${style}\\pos(${pos[0] + off},${pos[1]})\\1c${color}\\1a${alphaHex(0.75 * t.opacity)}\\3a&HFF&\\4a&HFF&}${body}` });
        ghost("&H4000FF&", split);
        ghost("&HFFFF00&", -split);
        lines.push({ layer: 1, start: s, end: e, text: `{${style}\\pos(${pos[0]},${pos[1]})${i % 3 === 1 ? textAl.hide : textAl.show}}${body}` });
      }
      settle = end;
      if (settle >= endSec - 1e-6) continue;
    }
    if (t.glow) {
      // A thin, translucent border blurred wide reads as a halo; a thick one merges into a box.
      line(0, settle, endSec, body, { glow: true, entrance: t.anim !== "glitch", extra: `\\blur${(t.glow * 3).toFixed(1)}\\bord${(fs * 0.045).toFixed(1)}\\3c${assColor(t.color)}\\1a&HFF&\\4a&HFF&` });
    }
    line(1, settle, endSec, body, { entrance: t.anim !== "glitch" });
  }
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Anton,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const body = lines
    .sort((a, b) => a.start - b.start || a.layer - b.layer)
    .map((l) => `Dialogue: ${l.layer},${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${l.text}`);
  return `${[...header, ...body].join("\n")}\n`;
}
