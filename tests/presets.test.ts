import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { briefDefaults } from "../src/presets/brief.js";
import { MEDIA_BUDGET } from "../src/presets/derive.js";
import { BriefFieldSchema, listPresets, type PresetEntry } from "../src/presets/library.js";
import { EdlSchema, gridBeats, resolveTime } from "../src/render/edl.js";

const builtIns = async () => (await listPresets()).filter((p) => p.source === "built-in");
const cards = (p: PresetEntry) => ((p.skeleton?.text ?? []) as { text: string; start: string | number }[]);
const fill = (format: string | undefined, value: string) => (format ?? "{value}").replace("{value}", value);
const SLUGS = ["cold-stare", "golden-hour", "hype-energy", "iron-mindset", "neon-rain", "night-stare", "phonk-velocity"];

describe("preset library", () => {
  it("loads every built-in preset, and every skeleton is a valid EDL once slots are filled", async () => {
    const presets = await listPresets();
    expect(presets.length).toBeGreaterThanOrEqual(4);
    for (const p of presets.filter((x) => x.skeleton)) {
      const filled = JSON.parse(JSON.stringify(p.skeleton).replace(/"slot:[a-z0-9_-]+"/g, '"black"'));
      const edl = EdlSchema.safeParse(filled);
      expect(edl.success, `${p.slug}: ${edl.success ? "" : edl.error.message}`).toBe(true);
      const ids = new Set(p.slots.map((s) => s.id));
      for (const m of JSON.stringify(p.skeleton).matchAll(/"slot:([a-z0-9_-]+)"/g)) expect(ids.has(m[1]!), `${p.slug} uses undefined slot ${m[1]}`).toBe(true);
    }
  });

  it("ships the golden-hour and neon-rain recipes under their own names", async () => {
    const presets = await listPresets();
    for (const [slug, title] of [["golden-hour", "Golden Hour"], ["neon-rain", "Neon Rain"]] as const) {
      const p = presets.find((x) => x.slug === slug);
      expect(p?.title).toBe(title);
      expect(p?.source).toBe("built-in");
      expect(basename(p!.dir)).toBe(slug);
    }
    // The old names matched, or nearly matched, presets in Higgsfield's Katana catalog.
    expect(presets.map((p) => p.slug)).not.toContain("dark-aura");
    expect(presets.map((p) => p.slug)).not.toContain("main-character");
  });
});

describe("built-in template content (spec §12.2)", () => {
  it("gives every built-in a title style, a brief, and a music input that matches its soundtrack", async () => {
    const presets = await builtIns();
    expect(presets.map((p) => p.slug).sort()).toEqual(SLUGS);
    for (const p of presets) {
      expect(p.display, `${p.slug} display`).toBeDefined();
      expect(p.brief.length, `${p.slug} brief`).toBeGreaterThan(0);
      for (const f of p.brief) expect(BriefFieldSchema.safeParse(f).success, `${p.slug}.${f.id}`).toBe(true);
      expect(new Set(p.brief.map((f) => f.id)).size, `${p.slug}: field ids are unique`).toBe(p.brief.length);
      // Until a template ships its own track, the person brings one (D5).
      expect(p.inputs.music, p.slug).toBe(p.soundtrack ? "optional" : "required");
    }
  });

  it("keeps hype-energy's words on its seven cards", async () => {
    const hype = (await builtIns()).find((p) => p.slug === "hype-energy")!;
    expect(cards(hype).map((t) => t.text)).toEqual(["NOTHING NEW", "SAME OLD DAY", "IS THAT ALL?", "BORN", "DIFFERENT", "PERIOD", "CROWN ACCEPTED"]);
    expect(hype.brief.filter((f) => f.binds.length).map((f) => f.id)).toEqual(["who", "day", "doubt", "drop", "slam", "closer"]);
  });

  it("reproduces every bound card's skeleton text from the brief defaults", async () => {
    for (const p of await builtIns()) {
      const defaults = briefDefaults(p.brief);
      const text = cards(p);
      for (const f of p.brief.filter((x) => x.binds.length)) {
        const value = defaults[f.id];
        const entries = f.kind === "words" ? value : [value];
        expect(Array.isArray(entries) && entries.length, `${p.slug}.${f.id}: one default per bound card`).toBe(f.binds.length);
        f.binds.forEach((b, i) => expect(fill(b.format, (entries as string[])[i]!), `${p.slug}.${f.id} → card ${b.index}`).toBe(text[b.index]?.text));
      }
    }
  });

  it("binds only cards that exist, each card at most once, and only on skeleton templates", async () => {
    for (const p of await builtIns()) {
      const indices = p.brief.flatMap((f) => f.binds.map((b) => b.index));
      if (!p.skeleton) expect(indices, `${p.slug} has no cards to bind`).toEqual([]);
      for (const i of indices) expect(i, `${p.slug} bind ${i}`).toBeLessThan(cards(p).length);
      expect(new Set(indices).size, `${p.slug}: a card bound twice`).toBe(indices.length);
      for (const f of p.brief) if (f.kind === "words" && !f.binds.length) expect(f.verbatim && f.count, `${p.slug}.${f.id}: free words are verbatim with a count`).toBeTruthy();
    }
  });

  it("fits every default and suggestion in maxChars and the field's word count", async () => {
    for (const p of await builtIns()) {
      for (const f of p.brief) {
        const max = f.maxChars ?? Infinity;
        const entries = (v: unknown) => (Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : []);
        const count = f.binds.length || f.count || 1;
        for (const v of [f.default, f.placeholder, ...f.suggestions]) {
          for (const e of entries(v)) expect(e.length, `${p.slug}.${f.id} "${e}"`).toBeLessThanOrEqual(max);
          if (f.kind === "words" && v !== undefined) {
            const n = entries(v).length;
            if (f.binds.length) expect(n, `${p.slug}.${f.id} ${JSON.stringify(v)}`).toBe(f.binds.length);
            else expect(n, `${p.slug}.${f.id} ${JSON.stringify(v)}`).toBeLessThanOrEqual(count);
          }
          if (f.kind === "text" && v !== undefined) expect(typeof v, `${p.slug}.${f.id}: text takes one string`).toBe("string");
        }
      }
    }
  });

  it("keeps choice, colour and toggle fields consistent with what they change", async () => {
    for (const p of await builtIns()) {
      const skeleton = JSON.stringify(p.skeleton ?? {}).toLowerCase();
      for (const f of p.brief) {
        if (f.kind === "choice") {
          expect(f.options?.length, `${p.slug}.${f.id} options`).toBeGreaterThan(1);
          if (f.default !== undefined) expect(f.options, `${p.slug}.${f.id} default`).toContain(f.default);
          expect(f.prompt ?? f.optionPrompts, `${p.slug}.${f.id} tells the director`).toBeDefined();
          for (const k of Object.keys(f.optionPrompts ?? {})) expect(f.options, `${p.slug}.${f.id} prompt for "${k}"`).toContain(k);
        }
        if (f.kind === "color") {
          expect(String(f.default)).toMatch(/^#[0-9a-fA-F]{6}$/);
          for (const r of f.recolor ?? []) expect(skeleton, `${p.slug}.${f.id} recolours ${r.from}`).toContain(r.from.toLowerCase());
        }
        if (f.kind === "toggle") {
          expect(typeof f.default, `${p.slug}.${f.id} default`).toBe("boolean");
          expect(f.promptOn && f.promptOff, `${p.slug}.${f.id} prompts`).toBeTruthy();
        }
        if (f.prompt) expect(f.prompt, `${p.slug}.${f.id} prompt`).toContain("{value}");
      }
    }
  });

  it("lands each skeleton's drop beat inside the edit, on a grid once a soundtrack ships", async () => {
    for (const p of (await builtIns()).filter((x) => x.skeleton)) {
      const edl = EdlSchema.parse(JSON.parse(JSON.stringify(p.skeleton).replace(/"slot:[a-z0-9_-]+"/g, '"black"')));
      // A bundled track replaces the reference the beat times were tracked on: they must follow a fixed grid.
      if (p.soundtrack) expect(edl.grid, `${p.slug}: a soundtrack needs a grid`).toBeDefined();
      const grid = edl.grid ?? { bpm: p.timing?.nominalBpm ?? 120, phase: 0 };
      if (p.timing?.dropBeat === undefined) continue;
      const at = resolveTime(`b${p.timing.dropBeat}`, { fps: edl.canvas.fps, beats: gridBeats(grid, 600) });
      expect(at, `${p.slug} drop`).toBeGreaterThan(0);
      expect(at, `${p.slug} drop`).toBeLessThan(edl.canvas.durationSec ?? p.format.durationSec ?? Infinity);
    }
  });

  it("bundles only declared media that exists and fits the size budgets", async () => {
    let total = 0;
    for (const p of await builtIns()) {
      const declared: [keyof typeof MEDIA_BUDGET, string | undefined][] = [["example", p.example?.video], ["poster", p.example?.poster], ["soundtrack", p.soundtrack?.file], ["cutmap", p.cutmap]];
      for (const [kind, name] of declared) {
        if (!name) continue;
        expect(name, `${p.slug} ${kind} is a file in the preset folder`).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*\.[a-z0-9]+$/);
        const file = join(p.dir, name);
        expect(existsSync(file), `${p.slug}/${name} exists`).toBe(true);
        const bytes = statSync(file).size;
        expect(bytes, `${p.slug}/${name} within budget`).toBeLessThanOrEqual(MEDIA_BUDGET[kind]);
        total += bytes;
      }
      if (p.cutmap) expect(JSON.parse(readFileSync(join(p.dir, p.cutmap), "utf8")).shots?.length, `${p.slug} cut map`).toBeGreaterThan(0);
      if (p.example) expect(p.example.credit.length, `${p.slug} credit`).toBeGreaterThan(0);
    }
    expect(total).toBeLessThanOrEqual(MEDIA_BUDGET.total);
  });
});

describe("template media for the gallery", () => {
  it("credits each example with the models that made it and their licences", async () => {
    const { exampleCredit } = await import("../src/app/templates.js");
    for (const p of await builtIns()) {
      const credit = exampleCredit(p)!;
      expect(credit.startsWith(p.example!.credit.replace(/\.?$/, ".")), p.slug).toBe(true);
      // Every built-in example's keyframes came from Qwen-Image 2.1, whose licence is non-commercial.
      expect(credit, p.slug).toContain("keyframes Qwen-Image 2.1 (non-commercial licence)");
      expect(credit, p.slug).toMatch(/Wan 2\.2 \(Apache-2\.0\)/);
    }
  });

  it("puts each poster near the drop on a frame without the edit's words, a flash or a cut", async () => {
    const { posterTime } = await import("../src/presets/derive.js");
    // cold-stare: "NO" covers the drop; the poster moves to the clean stare before the words start.
    const cold = JSON.parse(readFileSync(join(process.cwd(), "presets", "cold-stare", "cutmap.json"), "utf8")) as { dropSec: number; text: { start: number; end: number }[]; flashes: { t: number; durationSec: number }[]; shots: { start: number }[]; durationSec: number };
    const at = posterTime({ target: cold.dropSec, durationSec: cold.durationSec, fps: 30, text: cold.text, flashes: cold.flashes.map((f) => ({ start: f.t, end: f.t + f.durationSec })), cuts: cold.shots.map((s) => s.start) });
    expect(cold.text.some((t) => at >= t.start - 0.07 && at <= t.end + 0.07)).toBe(false);
    // Small captions on screen the whole time don't send it to the end; a big word does move it.
    const hud = [{ start: 0, end: 12, size: 0.018 }, { start: 3, end: 3.75, size: 0.05 }];
    const t = posterTime({ target: 3, durationSec: 13, fps: 30, text: hud, flashes: [], cuts: [2.9, 3, 3.77] });
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(4.5);
    expect(t >= 2.83 && t <= 3.85).toBe(false);
  });
});
