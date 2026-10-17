import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { listPresets } from "../src/presets/library.js";
import { EdlSchema } from "../src/render/edl.js";

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
