import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { probe } from "../engine/probe.js";
import { dataHome, packageRoot } from "../util/paths.js";

export const CATEGORIES = ["personalized_edits", "style_transfer", "motion_transfer"] as const;

export const PresetSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string(),
  description: z.string(),
  category: z.enum(CATEGORIES),
  /** Reference edit bundled with the preset (relative to its folder). Recipes without one work from music alone. */
  reference: z.string().optional(),
  thumbnail: z.string().optional(),
  format: z.object({ aspect: z.string().default("9:16"), durationSec: z.number().positive().optional(), fps: z.number().positive().default(30) }).default({ aspect: "9:16", fps: 30 }),
  inputs: z
    .object({
      images: z.object({ min: z.number().int().min(0).default(1), max: z.number().int().max(40).default(5), title: z.string().default("Your character, product or outfit") }),
      music: z.enum(["required", "optional", "reference"]).default("reference"),
      instructionsMaxChars: z.number().int().default(2000),
    })
    .default({ images: { min: 1, max: 5, title: "Your character, product or outfit" }, music: "reference", instructionsMaxChars: 2000 }),
  /** Style locks and creative guidance the agent applies; prose for the agent, not code. */
  recipe: z
    .object({
      look: z.string().optional(),
      fonts: z.array(z.string()).default([]),
      palette: z.array(z.string()).default([]),
      energy: z.string().optional(),
      structure: z.array(z.object({ at: z.string(), role: z.string(), guidance: z.string() })).default([]),
      titles: z.string().optional(),
      music: z.string().optional(),
      generation: z.string().optional(),
    })
    .default({ fonts: [], palette: [], structure: [] }),
  /**
   * Shots the user's material must supply: each slot is filled by a generated still or clip (or user
   * footage) and referenced from the skeleton as "slot:<id>".
   */
  slots: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
        kind: z.enum(["still", "clip", "footage", "graphic"]),
        description: z.string(),
        /** Suggested generation operation and prompt guidance (in the slot's own words). */
        operation: z.string().optional(),
        guidance: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * An edit skeleton in the EDL format (times preferably in beats "b<n>"), whose shot sources are
   * "slot:<id>", colours or "black"/"white". The agent copies it into katana_edit after filling the slots.
   */
  skeleton: z.record(z.string(), z.unknown()).optional(),
  /** Author's creative context; @image1.. refer to the user's images in order. */
  prompt: z.string().max(4000).default(""),
  author: z.string().default("open-katana"),
});
export type Preset = z.infer<typeof PresetSchema>;

export interface PresetEntry extends Preset {
  source: "built-in" | "user";
  dir: string;
  referencePath?: string;
  thumbnailPath?: string;
}

export const userPresetsDir = () => join(dataHome(), "presets");
const builtInDir = () => join(packageRoot(), "presets");

async function readDir(dir: string, source: PresetEntry["source"]): Promise<PresetEntry[]> {
  if (!existsSync(dir)) return [];
  const out: PresetEntry[] = [];
  for (const slug of await readdir(dir)) {
    const file = join(dir, slug, "preset.json");
    if (!existsSync(file)) continue;
    try {
      const p = PresetSchema.parse(JSON.parse(await readFile(file, "utf8")));
      const folder = join(dir, slug);
      out.push({
        ...p,
        source,
        dir: folder,
        referencePath: p.reference ? join(folder, p.reference) : undefined,
        thumbnailPath: p.thumbnail ? join(folder, p.thumbnail) : undefined,
      });
    } catch (e) {
      process.stderr.write(`open-katana: skipping invalid preset ${file}: ${(e as Error).message}\n`);
    }
  }
  return out;
}

/** User presets shadow built-in ones with the same slug. */
export async function listPresets(filter: { query?: string; category?: string } = {}): Promise<PresetEntry[]> {
  const user = await readDir(userPresetsDir(), "user");
  const builtIn = (await readDir(builtInDir(), "built-in")).filter((b) => !user.some((u) => u.slug === b.slug));
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...user, ...builtIn].filter((p) => {
    if (filter.category && p.category !== filter.category) return false;
    const hay = `${p.slug} ${p.title} ${p.description} ${p.recipe.look ?? ""} ${p.prompt}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export async function getPreset(slug: string): Promise<PresetEntry> {
  const clean = slug.replace(/^\/?katana\//, "").replace(/^\//, "");
  const found = (await listPresets()).find((p) => p.slug === clean);
  if (!found) throw new Error(`No preset "${clean}". Use katana_presets to list them.`);
  return found;
}

/**
 * Saves a preset to the user library. A bundled reference must be 3–30 s (the community-preset rule),
 * and up to 40 example images may accompany it.
 */
export async function savePreset(preset: Preset, files: { reference?: string; images?: string[] }): Promise<PresetEntry> {
  const dir = join(userPresetsDir(), preset.slug);
  await mkdir(dir, { recursive: true });
  const p: Preset = { ...preset };
  if (files.reference) {
    const info = await probe(files.reference);
    if (!info.video) throw new Error("The preset reference must be a video");
    if (info.durationSec < 3 || info.durationSec > 30) throw new Error(`Preset references must be 3–30 s long; this one is ${info.durationSec.toFixed(1)} s`);
    const name = `reference${extname(files.reference).toLowerCase() || ".mp4"}`;
    await copyFile(files.reference, join(dir, name));
    p.reference = name;
  }
  if (files.images?.length) {
    if (files.images.length > 40) throw new Error("A preset can carry at most 40 images");
    await mkdir(join(dir, "images"), { recursive: true });
    for (const [i, img] of files.images.entries()) await copyFile(img, join(dir, "images", `${i + 1}${extname(img).toLowerCase()}`));
  }
  await writeFile(join(dir, "preset.json"), JSON.stringify(PresetSchema.parse(p), null, 2));
  return getPreset(p.slug);
}
