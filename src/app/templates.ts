import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { briefDefaults } from "../presets/brief.js";
import { deriveTemplate } from "../presets/derive.js";
import { listPresets, type PresetEntry } from "../presets/library.js";
import { slugify } from "../project/workspace.js";
import { TextSchema } from "../render/edl.js";
import { VERSION } from "../server/server.js";
import { cutMapFromPreset } from "./cutmap.js";
import { isId, safeJoin, trashDir, trashName } from "./http.js";
import { aspectValue, withProject } from "./projects.js";
import { HttpError } from "./router.js";
import { profile } from "../comfy/operations.js";
import { estimateDraft, familyName, roleOf } from "./runs/estimate.js";
import type { CutMapData, Estimate, RunDraft, SaveTemplateRequest, TemplateCard, TemplateDetail, TitleStyle } from "./types.js";

// The template gallery (spec §7.2, §12.1): presets as cards and detail pages, their bundled files, and the
// templates people save from their own edits.

export async function templateEntry(slug: string): Promise<PresetEntry> {
  if (!isId("slug", slug)) throw new HttpError(400, "That isn't a valid template name.", "BAD_ID");
  const entry = (await listPresets()).find((p) => p.slug === slug);
  if (!entry) throw new HttpError(404, `No template "${slug}".`, "NO_TEMPLATE");
  return entry;
}

/** The only files of a template folder that are served: its example, poster, cut map and soundtrack. */
export function templateFileNames(p: PresetEntry): string[] {
  return [p.example?.video, p.example?.poster, p.cutmap, p.soundtrack?.file].filter((f): f is string => Boolean(f));
}

function fileUrl(p: PresetEntry, file: string | undefined): string | undefined {
  if (!file || !existsSync(join(p.dir, file))) return undefined;
  const url = `/templates/${p.slug}/${file.split("/").map(encodeURIComponent).join("/")}`;
  // Built-in files are cached forever; the version keeps an upgrade from showing stale media.
  return p.source === "built-in" ? `${url}?v=${encodeURIComponent(VERSION)}` : url;
}

const isShotForShot = (p: PresetEntry) => Boolean(p.skeleton && p.slots.length);

/** True when any value anywhere in `v` is `key` (deep search of a skeleton). */
function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => (k === key && x !== undefined && x !== null) || hasKey(x, key));
  return false;
}

/** How often a skeleton names `slot:<id>`. */
function slotUses(skeleton: unknown, id: string): number {
  const want = `slot:${id}`;
  let n = 0;
  const walk = (v: unknown) => {
    if (v === want) n++;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(skeleton);
  return n;
}

async function bundledCutMap(p: PresetEntry): Promise<CutMapData | undefined> {
  if (!p.cutmap) return undefined;
  try {
    return JSON.parse(await readFile(safeJoin(p.dir, encodeURIComponent(p.cutmap)), "utf8")) as CutMapData;
  } catch {
    return undefined;
  }
}

const reported = new Set<string>();

/** The template's Cut Map; an empty one (never a broken card) when it can't be built. */
async function templateCutMap(p: PresetEntry, aspect: number): Promise<CutMapData> {
  try {
    return cutMapFromPreset(p, { cutmapFile: await bundledCutMap(p) });
  } catch (e) {
    if (!reported.has(p.slug)) {
      reported.add(p.slug);
      process.stderr.write(`open-katana: no cut map for template ${p.slug}: ${(e as Error).message}\n`);
    }
    return { durationSec: p.format.durationSec ?? 0, aspect, shots: [], flashes: [], beats: [], downbeats: [], text: [], approximate: true };
  }
}

function titleStyle(p: PresetEntry): TitleStyle {
  if (p.display) return { font: p.display.font, weight: p.display.weight, italic: p.display.italic, case: p.display.case, color: p.display.color };
  return { font: p.recipe.fonts[0] ?? "Anton", weight: 400, italic: false, case: "upper", color: "#ECE7DC" };
}

/**
 * The example's credit line with the models that made it and their licences, as the receipt names them:
 * "… Made with: keyframes Qwen-Image 2.1 (non-commercial licence), clips Wan 2.2 (Apache-2.0)." A face crop
 * is a crop, not a model, so it is left out.
 */
export function exampleCredit(p: Pick<PresetEntry, "example">): string | undefined {
  const credit = p.example?.credit?.trim();
  if (!credit) return undefined;
  const order = ["keyframes", "plates", "clips", "transitions", "reference clips", "motion clips", "cut-outs"];
  // One entry per model family: the roles it played, then its licence.
  const families = new Map<string, { name: string; licence: string; roles: Set<string> }>();
  for (const id of p.example?.models ?? []) {
    let prof;
    try {
      prof = profile(id);
    } catch {
      continue;
    }
    if (prof.operation === "still.face") continue;
    const name = familyName(id);
    const licence = prof.license.commercial === "no" ? "non-commercial licence" : prof.license.name;
    const key = `${name}|${licence}`;
    const f = families.get(key) ?? { name, licence, roles: new Set<string>() };
    f.roles.add(roleOf(id));
    families.set(key, f);
  }
  if (!families.size) return credit;
  const rank = (role: string) => (order.indexOf(role) + 1 || order.length + 1);
  const parts = [...families.values()]
    .map((f) => ({ ...f, roles: [...f.roles].sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => rank(a.roles[0]!) - rank(b.roles[0]!))
    .map((f) => `${f.roles.join(" and ")} ${f.name} (${f.licence})`);
  return `${credit.replace(/\.?$/, ".")} Made with: ${parts.join(", ")}.`;
}

export async function templateCard(p: PresetEntry): Promise<TemplateCard> {
  const aspect = aspectValue(p.format.aspect) ?? 9 / 16;
  const cutMap = await templateCutMap(p, aspect);
  const kind = isShotForShot(p) ? "shot-for-shot" : "freestyle";
  const durationSec = p.format.durationSec ?? (cutMap.durationSec || undefined);
  const grid = (p.skeleton as { grid?: { bpm?: number } } | undefined)?.grid;
  const bpm = grid?.bpm ?? p.timing?.nominalBpm ?? p.soundtrack?.bpm;
  const texts = Array.isArray((p.skeleton as { text?: unknown[] } | undefined)?.text) ? (p.skeleton as { text: unknown[] }).text.length : cutMap.text.length;
  const flashing =
    hasKey(p.skeleton, "strobe") ||
    hasKey(p.skeleton, "frameStrobe") ||
    (durationSec ? cutMap.flashes.length / durationSec >= 0.4 : false) ||
    (kind === "freestyle" && /strob/i.test(JSON.stringify(p.recipe)));
  const poster = fileUrl(p, p.example?.poster);
  const example = fileUrl(p, p.example?.video);
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    source: p.source,
    kind,
    format: { aspect: p.format.aspect, aspectValue: aspect, ...(durationSec ? { durationSec } : {}), fps: p.format.fps },
    stats: {
      ...(cutMap.shots.length ? { shots: cutMap.shots.length } : {}),
      ...(texts ? { texts } : {}),
      ...(cutMap.flashes.length ? { flashes: cutMap.flashes.length } : {}),
      ...(bpm ? { bpm } : {}),
      ...(p.slots.length ? { slots: p.slots.length } : {}),
    },
    titleStyle: titleStyle(p),
    media: { ...(poster ? { poster } : {}), ...(example ? { example } : {}) },
    ...(example && exampleCredit(p) ? { credit: exampleCredit(p) } : {}),
    flashing,
    cutMap,
    inputs: {
      images: p.inputs.images,
      music: p.soundtrack ? "optional" : p.inputs.music === "optional" ? "optional" : "required",
      instructionsMaxChars: p.inputs.instructionsMaxChars,
    },
  };
}

/** Templates for the gallery: the person's own first, then the built-ins, each group by title. */
export async function listTemplates(): Promise<TemplateCard[]> {
  const presets = (await listPresets()).sort((a, b) => (a.source === b.source ? a.title.localeCompare(b.title) : a.source === "user" ? -1 : 1));
  return Promise.all(presets.map(templateCard));
}

/** A receipt that says the estimate isn't available, so the page still renders. */
function unavailableEstimate(p: PresetEntry, message: string): Estimate {
  return {
    key: "0".repeat(16),
    basis: isShotForShot(p) ? "skeleton" : "recipe",
    gpu: { lowMin: 0, highMin: 0, suggestedCapMin: 0, where: "local", target: "", note: "" },
    claude: { lowUsd: 0, highUsd: 0, suggestedCapUsd: 0, auth: "unknown", note: "" },
    wall: { lowMin: 0, highMin: 0 },
    groups: [],
    jobs: [],
    licences: [],
    canUseWan22: false,
    warnings: [{ code: "ESTIMATE_UNAVAILABLE", message: `No estimate yet: ${message}` }],
    blockers: [],
  };
}

/** The default receipt for the template page: no photos counted, its own track or none, the current GPU. */
async function defaultEstimate(p: PresetEntry): Promise<Estimate> {
  try {
    const draft: RunDraft = {
      kind: "template",
      template: p.slug,
      photos: [],
      musicChoice: p.soundtrack ? "template" : "mine",
      alignDrop: true,
      mode: "remix",
      brief: briefDefaults(p.brief),
      planFirst: false,
      commercial: false,
      clipsModel: "configured",
    };
    return (await estimateDraft(draft)).estimate;
  } catch (e) {
    return unavailableEstimate(p, (e as Error).message);
  }
}

export async function templateDetail(p: PresetEntry): Promise<TemplateDetail> {
  const card = await templateCard(p);
  const skeletonText = Array.isArray((p.skeleton as { text?: unknown[] } | undefined)?.text) ? (p.skeleton as { text: unknown[] }).text : [];
  const words: TemplateDetail["words"] = [];
  for (const [index, raw] of skeletonText.entries()) {
    const t = TextSchema.safeParse(raw);
    if (!t.success) continue;
    const timed = card.cutMap.text.find((x) => x.index === index);
    words.push({
      index,
      text: t.data.text,
      startSec: timed?.start ?? (typeof t.data.start === "number" ? t.data.start : 0),
      endSec: timed?.end ?? (typeof t.data.end === "number" ? t.data.end : 0),
      font: t.data.font,
      weight: t.data.weight ?? 400,
      italic: t.data.italic,
      uppercase: t.data.uppercase,
    });
  }
  const soundtrackUrl = fileUrl(p, p.soundtrack?.file);
  return {
    ...card,
    structure: p.recipe.structure,
    slots: p.slots.map((s) => ({ id: s.id, kind: s.kind, description: s.description, uses: slotUses(p.skeleton, s.id) })),
    words,
    brief: p.brief,
    ...(p.soundtrack && soundtrackUrl
      ? {
          soundtrack: {
            url: soundtrackUrl,
            title: p.soundtrack.title,
            ...(p.soundtrack.artist ? { artist: p.soundtrack.artist } : {}),
            licence: p.soundtrack.licence,
            ...(p.soundtrack.bpm ? { bpm: p.soundtrack.bpm } : {}),
            ...(p.soundtrack.dropSec !== undefined ? { dropSec: p.soundtrack.dropSec } : {}),
          },
        }
      : {}),
    ...(p.recipe.look ? { look: p.recipe.look } : {}),
    estimate: await defaultEstimate(p),
  };
}

/**
 * Saves a delivered edit of a decoded video as a local template. 409 SLUG_TAKEN when any template has the
 * name already, 422 NOT_TEMPLATABLE with the reasons when the edit can't become one.
 */
export async function saveTemplate(req: SaveTemplateRequest): Promise<TemplateDetail> {
  const slug = req.slug ?? slugify(req.title);
  if (!isId("slug", slug)) throw new HttpError(400, "Give the template a name with letters or numbers.", "BAD_ID");
  if ((await listPresets()).some((p) => p.slug === slug)) throw new HttpError(409, `There's already a template called "${slug}". Pick another name.`, "SLUG_TAKEN");
  const r = await withProject(req.fromProject, (ws) => deriveTemplate(ws, { title: req.title, slug, description: req.description ?? "" })).catch((e: Error & { code?: string }) => {
    // Another save took the name while this one was deriving.
    if (e.code === "SLUG_TAKEN") throw new HttpError(409, e.message, "SLUG_TAKEN");
    throw e;
  });
  if (!r.ok) throw new HttpError(422, r.reasons[0] ?? "This edit can't become a template.", "NOT_TEMPLATABLE", { reasons: r.reasons });
  return templateDetail(r.entry);
}

/** Moves a saved template to the trash. 403 for built-ins; 409 while an edit from it is being made. */
export async function deleteTemplate(slug: string, activeTemplates: Set<string>): Promise<void> {
  const entry = await templateEntry(slug);
  if (entry.source === "built-in") throw new HttpError(403, "Built-in templates can't be deleted.", "BUILT_IN");
  if (activeTemplates.has(slug)) throw new HttpError(409, "An edit from this template is being made. Stop it first.", "RUN_ACTIVE");
  await mkdir(trashDir(), { recursive: true });
  await rename(entry.dir, join(trashDir(), trashName(`template-${slug}`)));
}
