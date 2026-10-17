import type { BriefField, BriefFile, BriefValue, FieldProblem, MusicChoice, TrackFit } from "../app/types.js";
import type { Edl, Time } from "../render/edl.js";
import type { Preset } from "./library.js";

// The brief: the person's words and choices, bound to a template's text cards (spec §11.5). The app
// writes the resolved brief to plan/brief.json; katana_edit fromPreset applies it, and in app runs
// katana_edit refuses an EDL that changes the bound words.

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Each field's `default`, else its `placeholder`. */
export function briefDefaults(fields: BriefField[]): Record<string, BriefValue> {
  const out: Record<string, BriefValue> = {};
  for (const f of fields) {
    const v = f.default ?? f.placeholder;
    if (v !== undefined) out[f.id] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// ---------- OKLCH (Björn Ottosson's OKLab), for recolours that keep a shade's lightness ----------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** Linear sRGB of an OKLCH colour (may fall outside 0..1). */
function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** The colour with its OKLCH lightness set to `lightness`, its hue kept and its chroma reduced until it fits in sRGB. */
export function withLightness(hex: string, lightness: number): string {
  const [, C, h] = hexToOklch(hex);
  if (inGamut(oklchToLinear(lightness, C, h))) return toHex(oklchToLinear(lightness, C, h));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(lightness, mid, h))) lo = mid;
    else hi = mid;
  }
  return toHex(oklchToLinear(lightness, lo, h));
}

// ---------- resolving ----------

/** The person's value in a template; a replacer function, so "$&", "$'" or "$$" in it are kept as written. */
const fill = (template: string, value: string) => template.replaceAll("{value}", () => value);

/**
 * Validates the values against the template's fields (or `o.fields`, e.g. DECODE_BRIEF) and builds
 * plan/brief.json: the bound words with their skeleton card starts, the words that must appear
 * verbatim, recolours, the grid, length and soundtrack from the track fit, and the BRIEF lines.
 * A missing value takes the field's default; problems name the field and say what to change.
 */
export function resolveBrief(
  preset: Preset | undefined,
  values: Record<string, BriefValue>,
  o: { fit?: TrackFit; musicChoice: MusicChoice; fields?: BriefField[] },
): { file: BriefFile; problems: FieldProblem[] } {
  const fields = o.fields ?? ((preset?.brief ?? []) as BriefField[]);
  const cards = ((preset?.skeleton as { text?: { start: Time; text: string }[] } | undefined)?.text ?? []) as { start: Time; text: string }[];
  const problems: FieldProblem[] = [];
  const file: BriefFile = { v: 1, ...(preset ? { template: preset.slug } : {}), words: [], verbatim: [], recolor: [], promptLines: [] };
  const problem = (f: BriefField, message: string) => problems.push({ field: f.id, message });
  const tooLong = (f: BriefField, s: string) => f.maxChars !== undefined && [...s].length > f.maxChars;
  const bind = (f: BriefField, i: number, text: string) => {
    const b = f.binds[i]!;
    const card = cards[b.index];
    if (!card) return problem(f, `This template has no text card ${b.index}.`);
    file.words.push({ index: b.index, start: card.start, text: b.format ? fill(b.format, text) : text });
  };

  for (const f of fields) {
    const raw = values[f.id] ?? f.default;
    switch (f.kind) {
      case "text":
      case "choice":
      case "color": {
        if (raw !== undefined && typeof raw !== "string") {
          problem(f, "Use text here.");
          break;
        }
        let value = (raw ?? "").trim();
        if (!value) {
          if (f.required) problem(f, `Fill in: ${f.label}`);
          // An optional bound card that was cleared keeps the template's own words.
          if (f.binds.length && typeof f.default === "string" && f.default.trim()) value = f.default.trim();
          else break;
        }
        if (tooLong(f, value)) {
          problem(f, `Keep it to ${f.maxChars} characters.`);
          break;
        }
        if (f.kind === "choice" && !f.allowOther && f.options && !f.options.includes(value)) {
          problem(f, `Pick one of: ${f.options.join(", ")}.`);
          break;
        }
        if (f.kind === "color") {
          if (!HEX.test(value)) {
            problem(f, "Use a colour like #15319B.");
            break;
          }
          value = value.toUpperCase();
          // The template's own colour keeps every shade exactly as the skeleton has it.
          const unchanged = typeof f.default === "string" && f.default.toUpperCase() === value;
          for (const r of f.recolor ?? []) file.recolor.push({ from: r.from, to: unchanged ? r.from : r.lightness !== undefined ? withLightness(value, r.lightness) : value });
        }
        f.binds.forEach((_, i) => bind(f, i, value));
        if (f.verbatim) file.verbatim.push(value);
        const line = f.kind === "choice" ? (f.optionPrompts?.[value] ?? (f.prompt ? fill(f.prompt, value) : undefined)) : f.prompt ? fill(f.prompt, value) : undefined;
        if (line) file.promptLines.push(line);
        break;
      }
      case "words": {
        if (raw !== undefined && typeof raw !== "string" && !Array.isArray(raw)) {
          problem(f, "Use a list of words here.");
          break;
        }
        const given = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map((w) => String(w).trim());
        if (f.binds.length) {
          // One entry per bound card, in order; a cleared entry of an optional field keeps the template's word.
          const fallback = Array.isArray(f.default) ? f.default : [];
          if (given.length !== f.binds.length) {
            problem(f, `Give ${f.binds.length} words, one per card.`);
            break;
          }
          const entries = given.map((w, i) => w || (f.required ? "" : (fallback[i]?.trim() ?? "")));
          if (entries.some((w) => !w)) {
            problem(f, f.required ? `Fill in: ${f.label}` : "Fill in every word.");
            break;
          }
          if (entries.some((w) => tooLong(f, w))) {
            problem(f, `Keep each to ${f.maxChars} characters.`);
            break;
          }
          entries.forEach((w, i) => bind(f, i, w));
          if (f.verbatim) file.verbatim.push(...entries);
          if (f.prompt) file.promptLines.push(fill(f.prompt, entries.join(" ")));
          break;
        }
        const entries = given.filter(Boolean);
        if (!entries.length) {
          if (f.required) problem(f, `Fill in: ${f.label}`);
          break;
        }
        if (f.count !== undefined && entries.length > f.count) {
          problem(f, `Up to ${f.count} ${f.count === 1 ? "entry" : "entries"}.`);
          break;
        }
        if (entries.some((w) => tooLong(f, w))) {
          problem(f, `Keep each to ${f.maxChars} characters.`);
          break;
        }
        if (f.verbatim) file.verbatim.push(...entries);
        if (f.prompt) file.promptLines.push(fill(f.prompt, entries.join(" · ")));
        break;
      }
      case "toggle": {
        if (raw !== undefined && typeof raw !== "boolean") {
          problem(f, "Use on or off here.");
          break;
        }
        const line = raw ? f.promptOn : f.promptOff;
        if (line) file.promptLines.push(line);
        break;
      }
    }
  }

  // The soundtrack: the template's track or the person's (both imported as asset "music"), or the decoded edit's own sound.
  if (o.musicChoice === "original") file.audio = { asset: "ref", offset: 0 };
  else {
    file.audio = { asset: "music", offset: o.fit?.offsetSec ?? 0 };
    if (o.fit) {
      file.grid = { ...o.fit.grid };
      file.durationSec = o.fit.durationSec;
    }
  }
  return { file, problems };
}

// ---------- applying and checking ----------

function recolour(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return HEX.test(value) ? (map.get(value.toUpperCase()) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => recolour(v, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, recolour(v, map)]));
  return value;
}

/**
 * Applies a brief to a skeleton (pure): the bound cards get the person's words, every colour equal to a
 * recolour's `from` becomes its `to`, and the grid, length and soundtrack follow the track fit.
 */
export function applyBrief(skeleton: Record<string, unknown>, brief: BriefFile): Record<string, unknown> {
  const map = new Map(brief.recolor.map((r) => [r.from.toUpperCase(), r.to]));
  const out = (map.size ? recolour(skeleton, map) : structuredClone(skeleton)) as Record<string, unknown>;
  const text = Array.isArray(out.text) ? (out.text as Record<string, unknown>[]) : [];
  for (const w of brief.words) {
    const card = text[w.index];
    if (card && typeof card === "object") card.text = w.text;
  }
  if (brief.grid) out.grid = { ...brief.grid };
  if (brief.durationSec) out.canvas = { ...((out.canvas as Record<string, unknown> | undefined) ?? {}), durationSec: brief.durationSec };
  if (brief.audio) {
    const audio = out.audio && typeof out.audio === "object" ? (out.audio as Record<string, unknown>) : {};
    out.audio = { ...audio, asset: brief.audio.asset, offset: brief.audio.offset };
  }
  return out;
}

/** "b1.28" and "b1.280" are the same time; seconds compare as numbers. */
function sameStart(a: Time, b: string | number): boolean {
  if (typeof a === "number" || typeof b === "number") return typeof a === typeof b && Math.abs(Number(a) - Number(b)) < 1e-6;
  const ma = a.match(/^([bf])(\d+(?:\.\d+)?)$/);
  const mb = b.match(/^([bf])(\d+(?:\.\d+)?)$/);
  return ma && mb ? ma[1] === mb[1] && Math.abs(Number(ma[2]) - Number(mb[2])) < 1e-9 : a === b;
}

const at = (start: string | number) => (typeof start === "number" ? `${start} s` : start);

/**
 * Problems with the person's words in an EDL, one sentence each; empty when every word is kept. Each
 * bound word must be the text of a card that starts where the skeleton's card did, and each verbatim
 * entry must appear on some card (case-insensitive).
 */
export function checkWords(edl: Edl, brief: BriefFile): string[] {
  const problems: string[] = [];
  for (const w of brief.words) {
    if (!edl.text.some((t) => t.text === w.text && sameStart(t.start, w.start))) problems.push(`Keep the person's words: the card at ${at(w.start)} must read ${JSON.stringify(w.text)}.`);
  }
  for (const v of brief.verbatim) {
    if (!edl.text.some((t) => t.text.toLowerCase().includes(v.toLowerCase()))) problems.push(`Keep the person's words: ${JSON.stringify(v)} must be on a card.`);
  }
  return problems;
}

/** The brief of a decoded edit: optional words and place (spec §4.7). */
export const DECODE_BRIEF: BriefField[] = [
  {
    id: "words",
    label: "Your words",
    kind: "words",
    required: false,
    allowOther: false,
    placeholder: "Leave empty and the director writes new words in the same style",
    suggestions: [],
    maxChars: 16,
    count: 6,
    binds: [],
    verbatim: true,
    collapsed: false,
  },
  {
    id: "place",
    label: "Where should it happen?",
    kind: "text",
    required: false,
    allowOther: false,
    placeholder: "Same kind of places as the original",
    suggestions: [],
    maxChars: 80,
    binds: [],
    verbatim: false,
    prompt: "Place: {value}",
    collapsed: false,
  },
];
