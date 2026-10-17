/**
 * Step-0 UI fixtures for the browse side: the 7 built-in templates as the gallery sees them, the Hype
 * Energy template page, a receipt and setup states. Served by the client's `?mock=1` mode; typed, so
 * `pnpm typecheck` keeps them in step with src/app/types.ts. Cut maps are computed from the real skeletons.
 */
import type { BriefField, CutMapData, CutMapShot, Estimate, SetupStatus, TemplateCard, TemplateDetail, TitleStyle } from "../../../../src/app/types.js";

/** [start, end, slot] rows to Cut Map cells. */
const cells = (rows: [number, number, string?][]): CutMapShot[] => rows.map(([start, end, slot]) => (slot ? { start, end, slot } : { start, end }));

/** A freestyle template's map: recipe blocks only, no shots. */
const sketchMap = (durationSec: number, aspect: number, blocks: [number, number, string][]): CutMapData => ({
  durationSec,
  aspect,
  shots: [],
  flashes: [],
  beats: [],
  downbeats: [],
  text: [],
  sketch: blocks.map(([start, end, label]) => ({ start, end, label })),
  approximate: true,
});

const coldStareMap: CutMapData = sketchMap(10, 0.563, [
  [0, 3, "stare"],
  [3, 8, "ladder"],
  [8, 10, "payoff"],
]);

const goldenHourMap: CutMapData = sketchMap(14, 0.563, [
  [0, 3.5, "introduction"],
  [3.5, 9.8, "moments"],
  [9.8, 14, "payoff"],
]);

const hypeEnergyMap: CutMapData = {
  durationSec: 16.433,
  aspect: 0.563,
  shots: cells([
    [0, 0.017, "temple"], [0.017, 0.033, "detail"], [0.033, 0.133, "sneaker"], [0.133, 0.5, "sneaker"],
    [0.5, 0.567, "sneaker"], [0.567, 0.917, "sneaker"], [0.917, 0.933, "low-angle"], [0.933, 0.95, "top-down"],
    [0.95, 1.033, "stand-wide"], [1.033, 1.717, "stand-wide"], [1.717, 1.817, "stand-wide"], [1.817, 1.883, "temple"],
    [1.883, 2.583, "temple"], [2.583, 2.6, "temple"], [2.6, 2.667, "low-angle"], [2.667, 3.417, "low-angle"],
    [3.417, 5.083, "stand-wide"], [5.083, 5.167, "spin"], [5.167, 5.917, "spin"], [5.917, 5.967, "spin"],
    [5.967, 6.75, "spin"], [6.75, 6.833, "walk"], [6.833, 7.583, "walk"], [7.583, 8.15, "smirk"],
    [8.15, 8.417, "smirk"], [8.417, 8.833, "top-down"], [8.833, 9.25, "walk"], [9.25, 9.667, "low-angle"],
    [9.667, 9.733, "head-turn"], [9.733, 10.083, "head-turn"], [10.083, 10.5, "detail"], [10.5, 10.567, "throne"],
    [10.567, 11.333, "throne"], [11.333, 11.4, "head-turn"], [11.4, 11.75, "head-turn"], [11.75, 12.583, "walk"],
    [12.583, 12.65, "temple"], [12.65, 13, "temple"], [13, 13.05, "top-down"], [13.05, 13.417, "top-down"],
    [13.417, 13.75, "sneaker"], [13.75, 13.833, "stand-wide"], [13.833, 13.9, "smirk"], [13.9, 14.25, "smirk"],
    [14.25, 14.333, "head-turn"], [14.333, 14.667, "head-turn"], [14.667, 14.75, "throne"], [14.75, 15.083, "throne"],
    [15.083, 16.433, "throne"],
  ]),
  flashes: [
    { t: 8.15, durationSec: 0.1, color: "#F3EACD" },
    { t: 8.417, durationSec: 0.09, color: "#F3EACD" },
    { t: 9.25, durationSec: 0.12, color: "#F3EACD" },
    { t: 10.083, durationSec: 0.09, color: "#F3EACD" },
    { t: 11.75, durationSec: 0.13, color: "#F3EACD" },
    { t: 13.417, durationSec: 0.13, color: "#F3EACD" },
    { t: 15.083, durationSec: 0.2, color: "#F3EACD" },
  ],
  beats: [
    0.5, 0.917, 1.333, 1.75, 2.167, 2.583, 3, 3.417, 3.833, 4.25, 4.667, 5.083, 5.5, 5.917, 6.333, 6.75, 7.167, 7.583, 8, 8.417, 8.833, 9.25, 9.667, 10.083, 10.5, 10.917, 11.333, 11.75, 12.167, 12.583, 13, 13.417, 13.833, 14.25, 14.667, 15.083, 15.5, 15.917, 16.333,
  ],
  downbeats: [0.5, 2.167, 3.833, 5.5, 7.167, 8.833, 10.5, 12.167, 13.833, 15.5],
  text: [
    { index: 0, start: 1.033, end: 1.767, text: "NOTHING NEW" },
    { index: 1, start: 2.667, end: 3.417, text: "SAME OLD DAY" },
    { index: 2, start: 7.667, end: 8.15, text: "IS THAT ALL?" },
    { index: 3, start: 8.183, end: 8.417, text: "BORN" },
    { index: 4, start: 8.417, end: 8.833, text: "DIFFERENT" },
    { index: 5, start: 11.867, end: 12.583, text: "PERIOD" },
    { index: 6, start: 15.283, end: 16.433, text: "CROWN ACCEPTED" },
  ],
};

const ironMindsetMap: CutMapData = {
  durationSec: 27.417,
  aspect: 1.778,
  shots: cells([
    [0, 1.331, "walkout"], [1.331, 2.578, "tunnel"], [2.578, 3.844, "profile"], [3.844, 4.502, "arrival"],
    [4.502, 5.084, "tunnel"], [5.084, 6.084, "doubt"], [6.084, 6.565, "stare"], [6.565, 7.666, "profile"],
    [7.666, 7.704, "action"], [7.704, 8.248, "action"], [8.248, 8.907, "detail"], [8.907, 9.16, "stare"],
    [9.16, 9.413, "victory"], [9.413, 9.73, "stare"], [9.73, 10.173, "celebrate"], [10.173, 10.211, "detail"],
    [10.211, 10.831, "detail"], [10.831, 11.419, "arrival"], [11.419, 11.666, "profile"], [11.666, 12.008, "doubt"],
    [12.008, 12.261, "celebrate"], [12.261, 12.666], [12.666, 13.337, "action"], [13.337, 14.002, "stare"],
    [14.002, 14.249, "action"], [14.249, 14.502, "profile"], [14.502, 15.236], [15.236, 15.831, "doubt"],
    [15.831, 16.502, "detail"], [16.502, 16.755, "embrace"], [16.755, 17.071, "stare"], [17.071, 17.767, "celebrate"],
    [17.767, 17.793, "practice"], [17.793, 19.002, "practice"], [19.002, 19.666, "stare"], [19.666, 20.173, "action"],
    [20.173, 20.236, "victory"], [20.236, 20.932, "victory"], [20.932, 21.502, "roar"], [21.502, 21.818, "embrace"],
    [21.818, 22.071], [22.071, 22.831, "roar"], [22.831, 24.097, "practice"], [24.097, 24.16],
    [24.16, 24.666, "roar"], [24.666, 25.331, "embrace"], [25.331, 26.919, "victory"], [26.919, 27.419],
  ]),
  flashes: [
    { t: 7.666, durationSec: 0.042, color: "#FFFFFF" },
    { t: 8.97, durationSec: 0.042, color: "#C8D4F0" },
    { t: 9.73, durationSec: 0.083, color: "#FFFFFF" },
    { t: 10.173, durationSec: 0.042, color: "#9FB7E8" },
    { t: 15.831, durationSec: 0.125, color: "#FFFFFF" },
    { t: 17.767, durationSec: 0.042, color: "#FFFFFF" },
    { t: 20.173, durationSec: 0.083, color: "#FFFFFF" },
    { t: 25.331, durationSec: 0.083, color: "#A0A0A0" },
  ],
  beats: [
    0.046, 0.679, 1.312, 1.945, 2.578, 3.211, 3.844, 4.476, 5.109, 5.742, 6.375, 7.008, 7.641, 8.274, 8.907, 9.54, 10.173, 10.806, 11.438, 12.071, 12.704, 13.337, 13.97, 14.603, 15.236, 15.869, 16.502, 17.135, 17.767, 18.4, 19.033, 19.666, 20.299, 20.932, 21.565, 22.198, 22.831, 23.464, 24.097, 24.73, 25.363, 25.995, 26.628, 27.261,
  ],
  downbeats: [0.046, 2.578, 5.109, 7.641, 10.173, 12.704, 15.236, 17.767, 20.299, 22.831, 25.363],
  text: [
    { index: 0, start: 0.489, end: 0.932, text: "NO ONE" },
    { index: 1, start: 0.932, end: 1.331, text: "SAW" },
    { index: 2, start: 1.331, end: 2.578, text: "what was coming." },
    { index: 3, start: 2.578, end: 4.002, text: "07" },
    { index: 4, start: 4.502, end: 5.426, text: "EVERY DAY" },
    { index: 5, start: 5.426, end: 6.084, text: "I CHOSE TO OUTWORK" },
    { index: 6, start: 6.084, end: 6.565, text: "and rise," },
    { index: 7, start: 6.565, end: 7.666, text: "NO MATTER WHAT." },
    { index: 8, start: 7.666, end: 9.249, text: "RISE" },
    { index: 9, start: 12.261, end: 12.666, text: "RELENTLESS." },
    { index: 10, start: 17.071, end: 17.767, text: "3" },
    { index: 11, start: 19.002, end: 19.666, text: "GRIND" },
    { index: 12, start: 19.002, end: 19.666, text: "THE COMEBACK · 2019" },
    { index: 13, start: 20.173, end: 20.995, text: "AGAIN!" },
    { index: 14, start: 23.147, end: 24.097, text: "THE LONG ROAD · 2024" },
    { index: 15, start: 25.584, end: 26.818, text: "Your Name." },
    { index: 16, start: 26.084, end: 26.818, text: "UNFINISHED" },
  ],
};

const neonRainMap: CutMapData = sketchMap(15, 0.563, [
  [0, 2.25, "introduction"],
  [2.25, 6, "identity"],
  [6, 6.75, "drop"],
  [6.75, 12.75, "escalation"],
  [12.75, 15, "payoff"],
]);

const nightStareMap: CutMapData = {
  durationSec: 11,
  aspect: 1.333,
  shots: cells([
    [0, 0.03, "back"], [0.03, 0.07, "back"], [0.07, 0.11, "back"], [0.11, 0.15, "back"],
    [0.15, 0.4, "back"], [0.43, 1.5, "scope"], [1.5, 2.58, "back"], [2.58, 2.94, "glare"],
    [2.97, 3, "glare"], [3, 3.1, "glare"], [3.1, 3.135, "glare"], [3.135, 3.4, "glare"],
    [3.4, 4.165, "stairs"], [4.165, 5.08, "street"], [5.08, 6.03, "elevator"], [6.03, 6.3, "eye"],
    [6.3, 6.425, "eye"], [6.425, 7.5, "stare"], [7.5, 8.38, "lamps"], [8.38, 9, "stare"],
    [9, 9.4, "run"], [9.4, 9.85, "stairs"], [9.85, 10.55, "escalator"],
  ]),
  flashes: [],
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11],
  downbeats: [0, 2, 4, 6, 8, 10],
  text: [
    { index: 0, start: 9.85, end: 10.02, text: "BUILT" },
    { index: 1, start: 10.02, end: 10.23, text: "IN" },
    { index: 2, start: 10.23, end: 10.45, text: "THE" },
    { index: 3, start: 10.45, end: 10.55, text: "DARK" },
  ],
  approximate: true,
};

const phonkVelocityMap: CutMapData = sketchMap(12, 0.563, [
  [0, 2.4, "hook"],
  [2.4, 7.2, "build"],
  [7.2, 7.8, "drop"],
  [7.8, 12, "payoff"],
]);

const hypeWords: TemplateDetail["words"] = [
  { index: 0, text: "NOTHING NEW", startSec: 1.033, endSec: 1.767, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 1, text: "SAME OLD DAY", startSec: 2.667, endSec: 3.417, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 2, text: "IS THAT ALL?", startSec: 7.667, endSec: 8.15, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 3, text: "BORN", startSec: 8.183, endSec: 8.417, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 4, text: "DIFFERENT", startSec: 8.417, endSec: 8.833, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 5, text: "PERIOD", startSec: 11.867, endSec: 12.583, font: "League Gothic", weight: 400, italic: true, uppercase: true },
  { index: 6, text: "CROWN ACCEPTED", startSec: 15.283, endSec: 16.433, font: "League Gothic", weight: 400, italic: true, uppercase: true },
];

const hypeSlots: TemplateDetail["slots"] = [
  { id: "temple", kind: "clip", uses: 6, description: "Chest-up shot, eye level: the hero raises one finger to the temple and holds a calm, confident stare into the lens." },
  {
    id: "detail",
    kind: "clip",
    uses: 2,
    description: "Extreme close-up of a hand on the outfit's signature detail (pulling a jacket zip up, fixing a collar, a bracelet, a chain).",
  },
  {
    id: "sneaker",
    kind: "clip",
    uses: 5,
    description: "Ground-level shot of the hero's shoe stepping down onto the ground, then resting; framed so a tight crop reads as a laces close-up.",
  },
  {
    id: "low-angle",
    kind: "clip",
    uses: 4,
    description: "Worm's-eye full body: camera on the ground between the feet looking up, the hero towers against the sky looking down at the lens, hands in pockets.",
  },
  { id: "top-down", kind: "clip", uses: 4, description: "Bird's-eye close-up: camera directly above, the hero looks straight up into the lens, ground filling the background." },
  { id: "stand-wide", kind: "clip", uses: 5, description: "Wide full-body shot of the hero standing in the location, hands in pockets, relaxed lean, like a casual phone shot." },
  { id: "spin", kind: "clip", uses: 4, description: "Full body from behind: the hero spins slowly on the spot with arms held out, turning to face the camera." },
  { id: "spin-matte", kind: "clip", uses: 0, description: "Subject matte of the spin clip (white subject on black), aligned frame for frame." },
  { id: "walk", kind: "clip", uses: 4, description: "Waist-down shot of the hero walking straight toward the camera, outfit and shoes in focus." },
  {
    id: "smirk",
    kind: "clip",
    uses: 4,
    description: "Extreme close-up of the face: one finger to the nose bridge (pushing glasses up if the hero wears them, or lowering sunglasses), a knowing half-smile.",
  },
  { id: "head-turn", kind: "clip", uses: 6, description: "Medium shot in profile: the hero snaps their head round to the lens so the hair swings out." },
  { id: "head-turn-matte", kind: "clip", uses: 0, description: "Subject matte of the head-turn clip, aligned frame for frame." },
  {
    id: "throne",
    kind: "clip",
    uses: 5,
    description: "Wide frontal shot: the hero walks to a plain chair in the middle of the location, sits, and leans back like it is a throne.",
  },
];

const hypeStructure: TemplateDetail["structure"] = [
  {
    at: "0–0.95 s (to b1.08)",
    role: "cold open",
    guidance:
      "Two 1-frame teasers (stare, outfit detail), then ground-level shoe step and a laces close-up, each landing with a zoom blur. Two more 1-frame angle inserts snap into the first wide.",
  },
  {
    at: "b1.08–b7",
    role: "understated setup",
    guidance: "Dutch wide spins in, then chest-up stare, then a vertical whip into worm's-eye legs. Two small plain titles undersell the hero.",
  },
  {
    at: "b7–b11",
    role: "photo-card collage",
    guidance: "White-bordered cards of earlier angles (one polaroid) slide in over the wide one per beat, four cards; two swap content just before the cut.",
  },
  {
    at: "b11–b17",
    role: "spin and isolate",
    guidance: "Arms-out spin in the location; mid-spin the background drops to black; then a walk-in with zoom blur. Music thins and breaks around 7.2 s.",
  },
  { at: "b17–b18.36", role: "the question", guidance: "Hard cut to an extreme close-up (nose-bridge push) with a doubting line; riser into the drop." },
  { at: "b18.36–b21", role: "drop", guidance: "Cream flash-cuts carry giant stacked words one per cut, then one black frame and three walk strips wiping in as clones." },
  {
    at: "b21–b34",
    role: "payoff montage",
    guidance:
      "Every beat is a flash-cut or a whip: towering low angle, head turn, zip pull with shake, chair sit, head turn on black, walk-in under the third word, laces, close-up smirk.",
  },
  {
    at: "b34–end",
    role: "finale",
    guidance: "Leaning back in the chair, then a flash-cut to the frontal 'throne' hold with a small claim title at the top; hold 1.35 s to the end.",
  },
];

const style = (font: string, color: string, o: Partial<TitleStyle> = {}): TitleStyle => ({ font, weight: 400, italic: false, case: "upper", color, ...o });

const inputs = (max: number, title: string): TemplateCard["inputs"] => ({ images: { min: 1, max, title }, music: "required", instructionsMaxChars: 2000 });

/** The gallery: user templates first (none here), then built-ins by title. No examples are rendered yet. */
export const templates: TemplateCard[] = [
  {
    slug: "cold-stare",
    title: "Cold Stare",
    description: "Minimal sigma stare edit: extreme close-ups on the eyes, freeze frames and zoom ladders on the beat, monochrome with one red accent and massive condensed type.",
    source: "built-in",
    kind: "freestyle",
    format: { aspect: "9:16", aspectValue: 0.563, durationSec: 10, fps: 30 },
    stats: {},
    titleStyle: style("Anton", "#E10600"),
    media: {},
    flashing: false,
    cutMap: coldStareMap,
    inputs: inputs(3, "Your character (sharp, front-facing face)"),
  },
  {
    slug: "golden-hour",
    title: "Golden Hour",
    description: "Soft golden-hour hero edit: dreamy warm grade, soft white flashes, gentle handheld drift, film grain and elegant serif captions.",
    source: "built-in",
    kind: "freestyle",
    format: { aspect: "9:16", aspectValue: 0.563, durationSec: 14, fps: 30 },
    stats: {},
    titleStyle: style("Playfair Display", "#F6C177", { italic: true, case: "lower" }),
    media: {},
    flashing: false,
    cutMap: goldenHourMap,
    inputs: inputs(5, "Your character (face and full outfit)"),
  },
  {
    slug: "hype-energy",
    title: "Hype Energy",
    description:
      "Understated-to-hype character edit on a tight 144 BPM grid: zoom-blur, whip and spin landings, a stacking photo-card collage, a spin that drops the background to black, then a flash-cut drop with giant stacked words, cloned walk tiles and a chair-as-throne finale.",
    source: "built-in",
    kind: "shot-for-shot",
    format: { aspect: "9:16", aspectValue: 0.563, durationSec: 16.433, fps: 60 },
    stats: { shots: 49, texts: 7, flashes: 7, bpm: 144, slots: 13 },
    titleStyle: style("League Gothic", "#FEFBF3", { italic: true }),
    media: {},
    flashing: true,
    cutMap: hypeEnergyMap,
    inputs: inputs(5, "Your character: face and full outfit"),
  },
  {
    slug: "iron-mindset",
    title: "Iron Mindset",
    description:
      "Black-and-white athlete mindset montage: a spoken-word intro set as small caps and italic serif asides, then a trap drop with giant translucent numerals and title words, kit colour kept in grey frames, blue duotone and gold accents, glitch and flash frames, split screens and a name card to close.",
    source: "built-in",
    kind: "shot-for-shot",
    format: { aspect: "16:9", aspectValue: 1.778, durationSec: 27.417, fps: 24 },
    stats: { shots: 48, texts: 17, flashes: 8, bpm: 94.8, slots: 15 },
    titleStyle: style("Anton", "#F7B723"),
    media: {},
    flashing: false,
    cutMap: ironMindsetMap,
    inputs: inputs(10, "Your athlete (face, build and kit), plus optional teammates, venue or trophies"),
  },
  {
    slug: "neon-rain",
    title: "Neon Rain",
    description: "Moody night aura edit: slow-motion hero moments in a rain-wet city, teal-and-black grade, glow, white flashes on the drops and slammed blackletter titles.",
    source: "built-in",
    kind: "freestyle",
    format: { aspect: "9:16", aspectValue: 0.563, durationSec: 15, fps: 30 },
    stats: {},
    titleStyle: style("UnifrakturMaguntia", "#2DE1C2", { case: "as-typed" }),
    media: {},
    flashing: false,
    cutMap: neonRainMap,
    inputs: inputs(5, "Your character (first image: clear face)"),
  },
  {
    slug: "night-stare",
    title: "Night Stare",
    description:
      "Lone-wolf night aura edit (11 s, 4:3, 24 fps): a hooded figure training while the city sleeps, cold teal and sodium-green grade with black-and-white inserts, uncanny eye beats (x-ray flicker, red-eye strip, a white iris strobed open on the drop) and a closing red serif line, one word at a time.",
    source: "built-in",
    kind: "shot-for-shot",
    format: { aspect: "4:3", aspectValue: 1.333, durationSec: 11, fps: 24 },
    stats: { shots: 23, texts: 4, flashes: 0, slots: 12 },
    titleStyle: style("Playfair Display", "#EB0B0E", { weight: 700 }),
    media: {},
    flashing: true,
    cutMap: nightStareMap,
    inputs: inputs(5, "Your character (clear face first; a back or full-body photo helps)"),
  },
  {
    slug: "phonk-velocity",
    title: "Phonk Velocity",
    description: "High-energy velocity edit: speed ramps that snap into slow motion on the beat, strobing black-and-white inserts, heavy shake on the bass and chromatic splits.",
    source: "built-in",
    kind: "freestyle",
    format: { aspect: "9:16", aspectValue: 0.563, durationSec: 12, fps: 30 },
    stats: {},
    titleStyle: style("Archivo Black", "#FF1E1E"),
    media: {},
    flashing: true,
    cutMap: phonkVelocityMap,
    inputs: inputs(5, "Your character or vehicle"),
  },
];

/** A brief field with the schema defaults filled in. */
const field = (f: Partial<BriefField> & Pick<BriefField, "id" | "label" | "kind">): BriefField => ({
  required: false,
  allowOther: false,
  suggestions: [],
  binds: [],
  verbatim: false,
  collapsed: false,
  ...f,
});

/** Hype Energy's brief (spec §12.2). */
export const hypeBrief: BriefField[] = [
  field({
    id: "who",
    label: "Who are you, plainly?",
    help: "Plain on purpose: the drop flips it. Up to 13 letters so it fits the frame.",
    kind: "text",
    binds: [{ index: 0 }],
    default: "NOTHING NEW",
    maxChars: 13,
    suggestions: ["NEW IN TOWN", "NINE TO FIVE", "QUIET ONE", "BACK ROW KID"],
  }),
  field({
    id: "day",
    label: "And your day?",
    kind: "text",
    binds: [{ index: 1 }],
    default: "SAME OLD DAY",
    maxChars: 13,
    suggestions: ["SAME COMMUTE", "LAST CLASS", "NIGHT SHIFT", "ANY TUESDAY"],
  }),
  field({
    id: "doubt",
    label: "The doubt, right before the drop",
    kind: "text",
    binds: [{ index: 2 }],
    default: "IS THAT ALL?",
    maxChars: 14,
    suggestions: ["OR IS IT?", "RIGHT?", "THAT'S IT?"],
  }),
  field({
    id: "drop",
    label: "Two words that slam in on the drop",
    help: "One word per flash-cut, huge.",
    kind: "words",
    binds: [{ index: 3 }, { index: 4 }],
    default: ["BORN", "DIFFERENT"],
    maxChars: 9,
    suggestions: [
      ["BUILT", "DIFFERENT"],
      ["MAIN", "EVENT"],
      ["LOCKED", "IN"],
      ["NO", "LIMITS"],
    ],
  }),
  field({
    id: "slam",
    label: "One word, on its own",
    help: "Lands alone after the photo cards.",
    kind: "text",
    binds: [{ index: 5 }],
    default: "PERIOD",
    maxChars: 8,
    suggestions: ["FACTS", "ALWAYS", "SEALED", "NEXT"],
  }),
  field({
    id: "closer",
    label: "The last line",
    kind: "text",
    binds: [{ index: 6 }],
    default: "CROWN ACCEPTED",
    maxChars: 16,
    suggestions: ["ERA STARTS NOW", "AURA +1000", "THRONE SECURED", "UNBOTHERED"],
  }),
  field({
    id: "place",
    label: "Where's your everyday?",
    kind: "text",
    default: "a rooftop car park",
    maxChars: 60,
    prompt: "Place: {value}, the whole edit happens here, soft overcast daylight.",
    suggestions: ["a train platform at dusk", "a quiet campus courtyard", "a corner shop at night", "a laundromat"],
  }),
  field({
    id: "outfit",
    label: "Keep my outfit from the photo",
    kind: "toggle",
    default: true,
    promptOn: "Wardrobe: exactly as in the photos.",
    promptOff: "Wardrobe: the director styles a look that fits the place; keep the face exactly.",
  }),
];

const job = (line: string, operation: string, profile: string, takes: number, minutes: number, videoSec?: number): Estimate["jobs"][number] =>
  videoSec ? { line, operation, profile, takes, videoSec, minutes } : { line, operation, profile, takes, minutes };

const HYPE_CLIPS: [string, number][] = [
  ["temple", 3],
  ["detail", 2],
  ["sneaker", 2.5],
  ["low-angle", 2],
  ["top-down", 2],
  ["stand-wide", 2.5],
  ["spin", 3],
  ["walk", 2.5],
  ["smirk", 2],
  ["head-turn", 2],
  ["throne", 3],
];

/** The receipt for Hype Energy on Comfy Cloud with a track uploaded: default models (Qwen-Image 2.1 keyframes, Wan 2.2 clips). */
export const hypeEstimate: Estimate = {
  key: "3f9a1c27b0d84e65",
  basis: "skeleton",
  gpu: {
    lowMin: 31,
    highMin: 42,
    suggestedCapMin: 50,
    where: "cloud",
    target: "https://cloud.comfy.org",
    note: "Uses Comfy Cloud GPU time from your plan. Credits are shared across your workspace.",
  },
  claude: { lowUsd: 3, highUsd: 8, suggestedCapUsd: 15, auth: "subscription", plan: "Claude Max", note: "counts toward your Claude Max plan", fiveHourUtilization: 0.41 },
  wall: { lowMin: 15, highMin: 30 },
  groups: [
    { label: "Keyframes", detail: "11 shots × 3 takes", profile: "qwen21-edit", profileTitle: "Qwen-Image 2.1 (identity keyframes, 25 steps)", minutes: { low: 13.2, high: 17.8 } },
    { label: "Face crop", detail: "1 crop", profile: "face-crop", profileTitle: "Face crop (YOLOv8 face detector)", minutes: { low: 0.2, high: 0.3 } },
    { label: "Clips", detail: "11 clips · 26.5 s", profile: "wan22-14b-i2v", profileTitle: "Wan 2.2 I2V A14B + lightx2v 4-step", minutes: { low: 15.4, high: 20.8 } },
    { label: "Cut-outs", detail: "2 cut-outs", profile: "birefnet", profileTitle: "BiRefNet background removal", minutes: { low: 1.2, high: 1.6 } },
    { label: "Queueing", detail: "25 jobs on Comfy Cloud", profile: "", profileTitle: "", minutes: { low: 1, high: 1.4 } },
  ],
  jobs: [
    job("face", "still.face", "face-crop", 1, 0.2),
    ...HYPE_CLIPS.flatMap(([slot, sec]) => [job(`${slot}-key`, "still.compose", "qwen21-edit", 3, 1.2), job(slot, "clip.i2v", "wan22-14b-i2v", 1, 1.4, sec)]),
    job("spin-matte", "matte", "birefnet", 1, 0.6, 3),
    job("head-turn-matte", "matte", "birefnet", 1, 0.6, 2),
  ],
  licences: [
    {
      profile: "qwen21-edit",
      title: "Qwen-Image 2.1 (identity keyframes, 25 steps)",
      role: "keyframes",
      name: "Qwen Research License",
      commercial: "no",
      note: "Research and evaluation use only.",
      url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
      acknowledged: false,
    },
  ],
  canUseWan22: false,
  track: {
    ok: true,
    bpm: 128,
    aligned: true,
    offsetSec: 38.86,
    dropSec: 47.8,
    durationSec: 18.42,
    grid: { bpm: 128, phase: 0.5 },
    note: "Your track: 128 BPM · drop found at 0:47. We'll start it at 0:38.9 so the drop hits the big moment.",
  },
  warnings: [{ code: "SHARED_CREDITS", message: "Comfy Cloud credits are shared across your workspace." }],
  blockers: [],
};

const H3_NOTE =
  "Use of the open weights and their outputs in the United States, European Union, United Kingdom and South Korea is not licensed, whether on your own GPU or on a hosted service such as Comfy Cloud; attribution required; separate authorisation above US$20M annual revenue. MiniMax's own API is under separate terms.";

/** The same receipt with MiniMax H3 chosen for clips (a user override), so the Wan 2.2 swap is offered. */
export const hypeEstimateH3: Estimate = {
  ...hypeEstimate,
  key: "a04e5d19c2b7f388",
  groups: hypeEstimate.groups.map((g) => (g.label === "Clips" ? { ...g, profile: "minimax-h3-i2v", profileTitle: "MiniMax H3 image-to-video + 8-step turbo" } : g)),
  jobs: hypeEstimate.jobs.map((j) => (j.operation === "clip.i2v" ? { ...j, profile: "minimax-h3-i2v" } : j)),
  licences: [
    ...hypeEstimate.licences,
    {
      profile: "minimax-h3-i2v",
      title: "MiniMax H3 image-to-video + 8-step turbo",
      role: "clips",
      name: "MiniMax H3 Community License",
      commercial: "restricted",
      note: H3_NOTE,
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      acknowledged: false,
    },
  ],
  canUseWan22: true,
};

/** The Hype Energy template page; its estimate is the default one (no photos, no track). */
export const hypeDetail: TemplateDetail = {
  ...templates[2]!,
  structure: hypeStructure,
  slots: hypeSlots,
  words: hypeWords,
  brief: hypeBrief,
  look: "Natural overcast daylight in one everyday location, soft and slightly warm with lifted blacks (black trousers read as #3B3B3A) and muted greens; no stylised grade. Closest built-in: dreamy (or none if the generated clips are already soft). Flash-cuts are a warm cream tint (#F3EACD) that washes over the titles. Two shots drop the background to pure black (subject matte over #000000).",
  estimate: { ...hypeEstimate, key: "c51b08e2d4a79f60", track: undefined },
};

const profiles: SetupStatus["gpu"]["profiles"] = [
  { id: "qwen21-edit", operation: "still.compose", title: "Qwen-Image 2.1 (identity keyframes, 25 steps)", ready: true, missing: [], links: [] },
  { id: "face-crop", operation: "still.face", title: "Face crop (YOLOv8 face detector)", ready: true, missing: [], links: [] },
  { id: "z-image-turbo", operation: "still.generate", title: "Z-Image Turbo (text to image, location plates)", ready: true, missing: [], links: [] },
  { id: "wan22-14b-i2v", operation: "clip.i2v", title: "Wan 2.2 I2V A14B + lightx2v 4-step", ready: true, missing: [], links: [] },
  { id: "wan22-14b-flf", operation: "clip.flf", title: "Wan 2.2 A14B first/last frame + lightx2v 4-step", ready: true, missing: [], links: [] },
  { id: "minimax-h3-r2v", operation: "clip.r2v", title: "MiniMax H3 reference-to-video (up to 9 references) + 4-step turbo", ready: true, missing: [], links: [] },
  { id: "birefnet", operation: "matte", title: "BiRefNet background removal", ready: true, missing: [], links: [] },
];

/** Everything ready: Claude Code signed in with Claude Max, Comfy Cloud connected, ffmpeg found. */
export const setupReady: SetupStatus = {
  version: "0.1.0",
  checkedAt: "2026-10-17T14:20:00.000Z",
  claude: { state: "ok", version: "2.1.302", auth: "subscription", plan: "Claude Max" },
  gpu: { state: "ok", kind: "cloud", where: "cloud", target: "https://cloud.comfy.org", detail: "Comfy Cloud", onDemandModels: true, keySaved: true, profiles },
  ffmpeg: { state: "ok", version: "7.1" },
  ready: { browse: true, decode: true, make: true },
  blockers: [],
};

/** No GPU yet: browsing and decoding work, making does not. */
export const setupNoGpu: SetupStatus = {
  ...setupReady,
  gpu: { state: "not-configured", profiles: [] },
  ready: { browse: true, decode: true, make: false },
  blockers: [{ code: "GPU_NOT_CONFIGURED", message: "Finish setup to make edits: connect a GPU. Browsing and decoding work now." }],
};

/** Claude Code installed but signed out: browsing and decoding work, making does not. */
export const setupSignedOut: SetupStatus = {
  ...setupReady,
  claude: { state: "logged-out", version: "2.1.302" },
  ready: { browse: true, decode: true, make: false },
  blockers: [{ code: "CLAUDE_LOGGED_OUT", message: "Finish setup to make edits: sign in to Claude Code. Browsing and decoding work now." }],
};

/** ffmpeg missing: nothing decodes or renders. */
export const setupNoFfmpeg: SetupStatus = {
  ...setupReady,
  ffmpeg: { state: "missing" },
  ready: { browse: true, decode: false, make: false },
  blockers: [{ code: "FFMPEG_MISSING", message: "Install ffmpeg to decode and render edits." }],
};

/** The Comfy Cloud key is only in the app's environment, so the director can't use it yet. */
export const setupEnvSecret: SetupStatus = {
  ...setupReady,
  gpu: { ...setupReady.gpu, state: "env-secret", keySaved: false },
  ready: { browse: true, decode: true, make: false },
  blockers: [{ code: "GPU_ENV_SECRET", message: "Your Comfy Cloud key is set in this terminal only. Save it so the director can use it." }],
};

/** This computer's ComfyUI, missing MiniMax H3 for reference clips. */
export const setupModelsMissing: SetupStatus = {
  ...setupReady,
  gpu: {
    state: "ok",
    kind: "http",
    where: "local",
    target: "http://127.0.0.1:8188",
    detail: "NVIDIA RTX 4090 (24 GB)",
    onDemandModels: false,
    profiles: profiles.map((p) =>
      p.id === "minimax-h3-r2v"
        ? { ...p, ready: false, missing: ["minimax_h3_r2v_fp8.safetensors", "minimax_h3_turbo_lora.safetensors"], links: ["https://huggingface.co/MiniMaxAI/MiniMax-H3"] }
        : p,
    ),
  },
  blockers: [{ code: "MODELS_MISSING", message: "This template needs models your ComfyUI doesn't have: MiniMax H3 (reference clips)." }],
};

/**
 * This computer's ComfyUI without the keyframe and clip models every template uses: connected, `ready.make`
 * true on the server, yet no template can be made (the pill says Finish setup).
 */
export const setupAllModelsMissing: SetupStatus = {
  ...setupModelsMissing,
  gpu: {
    ...setupModelsMissing.gpu,
    profiles: profiles.map((p) =>
      p.operation === "still.compose" || p.operation === "clip.i2v"
        ? { ...p, ready: false, missing: [`${p.id}.safetensors`], links: [`https://huggingface.co/${p.id}`], neededBy: templates.map((t) => t.title) }
        : p,
    ),
  },
  blockers: [],
};

/** Setup states the mock can serve, by `?setup=<name>`. */
export const setupStates: Record<string, SetupStatus> = {
  ready: setupReady,
  nogpu: setupNoGpu,
  signedout: setupSignedOut,
  ffmpeg: setupNoFfmpeg,
  secret: setupEnvSecret,
  models: setupModelsMissing,
  allmodels: setupAllModelsMissing,
};
