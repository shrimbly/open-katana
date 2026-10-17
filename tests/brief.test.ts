import { describe, expect, it } from "vitest";
import type { BriefField, TrackFit } from "../src/app/types.js";
import { applyBrief, briefDefaults, checkWords, DECODE_BRIEF, resolveBrief, withLightness } from "../src/presets/brief.js";
import { getPreset, type PresetEntry } from "../src/presets/library.js";
import { type Edl, EdlSchema } from "../src/render/edl.js";

const fit: TrackFit = { ok: true, bpm: 128, aligned: true, offsetSec: 38.9, dropSec: 47.2, durationSec: 18.32, grid: { bpm: 128, phase: 0.5 }, note: "" };
const fields = (p: PresetEntry) => p.brief as BriefField[];
/** A skeleton with every slot filled, as katana_edit fromPreset makes it. */
const filled = (p: PresetEntry) => JSON.parse(JSON.stringify(p.skeleton).replace(/"slot:[a-z0-9_-]+"/g, '"black"')) as Record<string, unknown>;

/** OKLCH lightness of a hex colour (for checking recolours). */
function lightness(hex: string): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

describe("resolveBrief", () => {
  it("binds the person's words to the skeleton's cards, with the cards' own start times", async () => {
    const hype = await getPreset("hype-energy");
    const values = { ...briefDefaults(fields(hype)), who: "NEW IN TOWN", drop: ["MAIN", "EVENT"] };
    const { file, problems } = resolveBrief(hype, values, { fit, musicChoice: "mine" });
    expect(problems).toEqual([]);
    expect(file.template).toBe("hype-energy");
    expect(file.words).toEqual([
      { index: 0, start: "b1.28", text: "NEW IN TOWN" },
      { index: 1, start: "b5.2", text: "SAME OLD DAY" },
      { index: 2, start: "b17.2", text: "IS THAT ALL?" },
      { index: 3, start: "b18.44", text: "MAIN" },
      { index: 4, start: "b19", text: "EVENT" },
      { index: 5, start: "b27.28", text: "PERIOD" },
      { index: 6, start: "b35.48", text: "CROWN ACCEPTED" },
    ]);
    expect(file.audio).toEqual({ asset: "music", offset: 38.9 });
    expect(file.grid).toEqual({ bpm: 128, phase: 0.5 });
    expect(file.durationSec).toBe(18.32);
  });

  it("writes the BRIEF lines from prompts, toggles and choices, skipping empty optional fields", async () => {
    const hype = await getPreset("hype-energy");
    const on = resolveBrief(hype, { ...briefDefaults(fields(hype)), place: "a laundromat" }, { musicChoice: "mine" }).file;
    expect(on.promptLines).toEqual(["Place: a laundromat, the whole edit happens here, soft overcast daylight.", "Wardrobe: exactly as in the photos."]);
    const off = resolveBrief(hype, { ...briefDefaults(fields(hype)), place: "", outfit: false }, { musicChoice: "mine" }).file;
    expect(off.promptLines).toEqual(["Wardrobe: the director styles a look that fits the place; keep the face exactly."]);
    const phonk = await getPreset("phonk-velocity");
    const car = resolveBrief(phonk, { star: "My car", word: "GONE" }, { musicChoice: "mine" }).file;
    expect(car.promptLines).toEqual(["Hero: the person's car from the photos; the person appears beside it."]);
    expect(car.verbatim).toEqual(["GONE"]);
    const iron = await getPreset("iron-mindset");
    const other = resolveBrief(iron, { name: "Ana", sport: "Rowing" }, { musicChoice: "mine" });
    expect(other.problems).toEqual([]);
    expect(other.file.promptLines[0]).toBe("Sport: Rowing. The action, detail and practice shots show this sport.");
  });

  it("applies bind formats and requires required fields", async () => {
    const iron = await getPreset("iron-mindset");
    const ok = resolveBrief(iron, { ...briefDefaults(fields(iron)), name: "Ana Lima" }, { musicChoice: "mine" });
    expect(ok.problems).toEqual([]);
    expect(ok.file.words.find((w) => w.index === 15)).toEqual({ index: 15, start: "b40.35", text: "Ana Lima." });
    const missing = resolveBrief(iron, { ...briefDefaults(fields(iron)), name: "  " }, { musicChoice: "mine" });
    expect(missing.problems).toEqual([{ field: "name", message: "Fill in: Your name, for the closing card" }]);
  });

  it("refuses words that are too long, the wrong count, colours that aren't colours and unknown choices", async () => {
    const hype = await getPreset("hype-energy");
    const base = briefDefaults(fields(hype));
    const r = resolveBrief(hype, { ...base, who: "FAR TOO MANY LETTERS", drop: ["ONE"], outfit: "yes" }, { musicChoice: "mine" });
    expect(r.problems).toEqual([
      { field: "who", message: "Keep it to 13 characters." },
      { field: "drop", message: "Give 2 words, one per card." },
      { field: "outfit", message: "Use on or off here." },
    ]);
    const iron = await getPreset("iron-mindset");
    const ironBase = { ...briefDefaults(fields(iron)), name: "Ana" };
    expect(resolveBrief(iron, { ...ironBase, kit: "blue" }, { musicChoice: "mine" }).problems).toEqual([{ field: "kit", message: "Use a colour like #15319B." }]);
    const choice: BriefField = { id: "x", label: "X", kind: "choice", required: false, options: ["A", "B"], allowOther: false, suggestions: [], binds: [], verbatim: false, collapsed: false };
    expect(resolveBrief(undefined, { x: "C" }, { musicChoice: "mine", fields: [choice] }).problems).toEqual([{ field: "x", message: "Pick one of: A, B." }]);
    const cold = await getPreset("cold-stare");
    expect(resolveBrief(cold, { words: ["A", "B", "C", "D", "E"] }, { musicChoice: "mine" }).problems).toEqual([{ field: "words", message: "Up to 4 entries." }]);
  });

  it("keeps the template's word when an optional bound field is cleared", async () => {
    const hype = await getPreset("hype-energy");
    const { file, problems } = resolveBrief(hype, { ...briefDefaults(fields(hype)), who: "" }, { musicChoice: "mine" });
    expect(problems).toEqual([]);
    expect(file.words[0]!.text).toBe("NOTHING NEW");
  });

  it("leaves every shade alone when the kit colour is the template's own", async () => {
    const iron = await getPreset("iron-mindset");
    const { file } = resolveBrief(iron, { ...briefDefaults(fields(iron)), name: "Ana" }, { musicChoice: "mine" });
    expect(file.recolor).toEqual([
      { from: "#15319B", to: "#15319B" },
      { from: "#254A91", to: "#254A91" },
    ]);
  });

  it("recolours the kit, keeping the darker shade's lightness", async () => {
    const iron = await getPreset("iron-mindset");
    const { file } = resolveBrief(iron, { ...briefDefaults(fields(iron)), name: "Ana", kit: "#c8102e" }, { musicChoice: "mine" });
    expect(file.recolor[0]).toEqual({ from: "#15319B", to: "#C8102E" });
    expect(file.recolor[1]!.from).toBe("#254A91");
    expect(lightness(file.recolor[1]!.to)).toBeCloseTo(0.45, 2);
    // A light, saturated colour forced dark stays in sRGB by giving up chroma, not hue.
    const dark = withLightness("#00FF66", 0.3);
    expect(dark).toMatch(/^#[0-9A-F]{6}$/);
    expect(lightness(dark)).toBeCloseTo(0.3, 2);
  });

  it("collects verbatim words for freestyle templates and the decoded-edit brief", async () => {
    const neon = await getPreset("neon-rain");
    const r = resolveBrief(neon, { title: "RARE", city: "a bus stop in the rain", captions: ["SO", "", "LATE"] }, { musicChoice: "mine" });
    expect(r.problems).toEqual([]);
    expect(r.file.verbatim).toEqual(["RARE", "SO", "LATE"]);
    expect(r.file.words).toEqual([]);
    expect(r.file.promptLines).toEqual(["Place: a bus stop in the rain at night, rain-wet, teal neon reflections."]);
    const decoded = resolveBrief(undefined, { words: ["MAIN", "EVENT"], place: "" }, { musicChoice: "original", fields: DECODE_BRIEF });
    expect(decoded.problems).toEqual([]);
    expect(decoded.file).toEqual({ v: 1, words: [], verbatim: ["MAIN", "EVENT"], recolor: [], promptLines: [], audio: { asset: "ref", offset: 0 } });
    expect(resolveBrief(undefined, { words: ["SEVENTEEN LETTERS"] }, { musicChoice: "original", fields: DECODE_BRIEF }).problems).toEqual([{ field: "words", message: "Keep each to 16 characters." }]);
  });
});

describe("applyBrief", () => {
  it("puts the words, grid, length and soundtrack on all three skeletons and keeps them valid EDLs", async () => {
    for (const slug of ["hype-energy", "iron-mindset", "night-stare"]) {
      const p = await getPreset(slug);
      const values = { ...briefDefaults(fields(p)), ...(slug === "iron-mindset" ? { name: "Ana" } : {}) };
      const { file, problems } = resolveBrief(p, values, { fit, musicChoice: "mine" });
      expect(problems, slug).toEqual([]);
      const skeleton = filled(p);
      const before = JSON.stringify(skeleton);
      const edl = EdlSchema.parse(applyBrief(skeleton, file));
      expect(JSON.stringify(skeleton), "pure").toBe(before);
      expect(edl.grid).toEqual({ bpm: 128, phase: 0.5 });
      expect(edl.canvas.durationSec).toBe(18.32);
      expect(edl.audio).toMatchObject({ asset: "music", offset: 38.9 });
      for (const w of file.words) expect(edl.text[w.index]!.text, `${slug} card ${w.index}`).toBe(w.text);
      expect(checkWords(edl, file), slug).toEqual([]);
    }
  });

  it("replaces every use of a recoloured colour, case-insensitively", async () => {
    const iron = await getPreset("iron-mindset");
    const { file } = resolveBrief(iron, { ...briefDefaults(fields(iron)), name: "Ana", kit: "#C8102E" }, { musicChoice: "mine" });
    const skeleton = filled(iron);
    const text = JSON.stringify(applyBrief(skeleton, file));
    expect(JSON.stringify(skeleton)).toContain("#15319B");
    expect(text).not.toMatch(/#15319B|#254A91/i);
    expect(text).toContain("#C8102E");
    expect(text).toContain(file.recolor[1]!.to);
  });
});

describe("checkWords", () => {
  it("names every card whose words changed or moved, and every verbatim word that's missing", async () => {
    const hype = await getPreset("hype-energy");
    const { file } = resolveBrief(hype, { ...briefDefaults(fields(hype)), who: "NEW IN TOWN" }, { musicChoice: "mine" });
    const edl: Edl = EdlSchema.parse(applyBrief(filled(hype), file));
    expect(checkWords(edl, file)).toEqual([]);
    edl.text[0]!.text = "NOTHING NEW";
    edl.text[1]!.start = "b5.4";
    expect(checkWords(edl, file)).toEqual([
      `Keep the person's words: the card at b1.28 must read "NEW IN TOWN".`,
      `Keep the person's words: the card at b5.2 must read "SAME OLD DAY".`,
    ]);
    // The same beat written another way is the same card.
    edl.text[0]!.text = "NEW IN TOWN";
    edl.text[1]!.start = "b5.20";
    expect(checkWords(edl, file)).toEqual([]);
    const words = { ...file, words: [], verbatim: ["Aura"] };
    expect(checkWords(edl, words)).toEqual([`Keep the person's words: "Aura" must be on a card.`]);
    edl.text[2]!.text = "AURA +1000";
    expect(checkWords(edl, words)).toEqual([]);
  });
});

describe("words with $ in them", () => {
  it("keep every character on the card and in the prompt lines", async () => {
    const iron = await getPreset("iron-mindset");
    const name = "PAID $$$ IN $& $'";
    const { file, problems } = resolveBrief(iron, { ...briefDefaults(fields(iron)), name }, { musicChoice: "mine" });
    expect(problems).toEqual([]);
    expect(file.words.find((w) => w.index === 15)?.text).toBe(`${name}.`);
    const hype = await getPreset("hype-energy");
    const r = resolveBrief(hype, { ...briefDefaults(fields(hype)), place: "a $$$ casino$'" }, { musicChoice: "mine" });
    expect(r.file.promptLines.some((l) => l.includes("a $$$ casino$'"))).toBe(true);
  });
});

