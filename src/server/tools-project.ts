import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ModelChoices } from "../comfy/backend.js";
import { type License, licenseLabel, licenseWarnings, OPERATIONS, PROFILES, profile } from "../comfy/operations.js";
import { checkProfile } from "../comfy/resolve.js";
import { chooseProfile, loadJobs } from "../comfy/jobs.js";
import { backendEnvOverrides, type Config, nextBackend } from "../config.js";
import { CATEGORIES, getPreset, listPresets, PresetSchema, savePreset } from "../presets/library.js";
import { MODES, ROLES, Workspace } from "../project/workspace.js";
import { FONTS } from "../render/fonts.js";
import { packageRoot } from "../util/paths.js";
import { result, safe, table } from "./content.js";
import type { State } from "./state.js";
import { WIDGETS, widgetMeta } from "./widgets.js";

const media = z.string().min(1).describe("Absolute file path or http(s) URL");

export function resumeLine(ws: Workspace): string {
  return `RESUME open-katana project=${ws.project.id} stage=${ws.project.stage}`;
}

async function skillText(): Promise<string> {
  const raw = await readFile(`${packageRoot()}/skills/katana/SKILL.md`, "utf8");
  return raw.replace(/^---[\s\S]*?---\s*/, "");
}

function section(md: string, heading: string): string | undefined {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, "").toLowerCase().startsWith(heading));
  if (start < 0) return undefined;
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** A compact view of a preset's edit skeleton: how often each slot is used and every text card. */
function skeletonSummary(skeleton: Record<string, unknown>): string {
  const sk = skeleton as { canvas?: { width: number; height: number; fps: number }; grid?: { bpm: number }; shots?: { start: unknown; end: unknown; source?: { asset?: string } }[]; text?: { text: string; start: unknown; end: unknown; font?: string; size?: number }[]; flashes?: unknown[] };
  const uses = new Map<string, number>();
  for (const m of JSON.stringify(skeleton).matchAll(/"slot:([a-z0-9_-]+)"/g)) uses.set(m[1]!, (uses.get(m[1]!) ?? 0) + 1);
  const lines = [
    `Edit skeleton: ${sk.shots?.length ?? 0} shots, ${sk.flashes?.length ?? 0} flashes, ${sk.text?.length ?? 0} text cards${sk.canvas ? `, ${sk.canvas.width}×${sk.canvas.height} at ${sk.canvas.fps} fps` : ""}${sk.grid ? `, ${sk.grid.bpm} BPM grid` : ""}.`,
    `Slot uses: ${[...uses].map(([k, v]) => `${k} ×${v}`).join(", ")}.`,
    sk.text?.length ? `Text cards (rewrite the words for this user, keep the rhythm):\n${table(["Words", "Start", "End", "Font", "Size"], sk.text.map((t) => [t.text, String(t.start), String(t.end), t.font, t.size]))}` : "",
    "After generating, build the edit with katana_edit fromPreset { slots: { <slot>: <accepted asset> } }; it fills the skeleton and shows the full EDL to adjust.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** The profile each operation would use now, with its licence, plus warnings for the restricted ones. */
function licenceReport(cfg: Config, catalog: { nodes: Set<string>; models: ModelChoices } | undefined, onDemandModels?: boolean) {
  const active: { operation: string; profile?: string; license?: License; error?: string }[] = OPERATIONS.map((operation) => {
    try {
      const id = chooseProfile({ operation }, { tier: cfg.tier, overrides: cfg.profiles, commercial: cfg.commercial, catalog, onDemandModels });
      return { operation, profile: id, license: profile(id).license };
    } catch (e) {
      return { operation, error: (e as Error).message };
    }
  });
  const warnings = licenseWarnings(active.flatMap((a) => (a.profile ? [a.profile] : [])), cfg.commercial);
  const nonCommercial = active.some((a) => a.license?.commercial === "no");
  const text = [
    `Profile per operation (commercial use: ${cfg.commercial ? "on, so defaults skip non-commercial models" : "off"}):`,
    table(["Operation", "Profile", "Licence", "Commercial use"], active.map((a) => [a.operation, a.profile ?? a.error, a.license?.name, a.license?.commercial])),
    ...(warnings.length ? ["", "Licence warnings (summaries of each model's licence, not legal advice):", ...warnings.map((w) => `- ${w}`)] : []),
    ...(nonCommercial && !cfg.commercial ? ["If the output is for commercial use, run katana_backend set with commercial: true."] : []),
  ].join("\n");
  return { active, warnings, text };
}

export function registerProjectTools(server: McpServer, state: State): void {
  server.registerTool(
    "katana_guide",
    {
      title: "open-katana workflow guide",
      description:
        "Returns the open-katana workflow instructions. Call once at the start of a run if the katana skill is not already loaded. Topics: workflow (default, the whole guide), modes, generation, aura, rules, fonts.",
      inputSchema: z.object({ topic: z.enum(["workflow", "modes", "generation", "aura", "rules", "fonts"]).default("workflow") }),
      annotations: { readOnlyHint: true },
    },
    safe(async ({ topic }) => {
      if (topic === "fonts") {
        return result(
          `${table(["Font", "Character"], Object.entries(FONTS).map(([k, v]) => [k, v.style]))}\n\nSet \`weight\` (100–900) for a real Light/Medium/Bold/Black face and \`italic\` for the family's true italic; both are fetched as static faces on first use (families without such a face fall back to a synthesised one). Sizes are true cap heights, so match the reference's measured cap height directly.`,
        );
      }
      const md = await skillText();
      const map: Record<string, string> = { modes: "modes", generation: "generation", aura: "aura", rules: "rules" };
      const body = topic === "workflow" ? md : (section(md, map[topic]!) ?? md);
      return result(body);
    }),
  );

  server.registerTool(
    "katana_presets",
    {
      title: "open-katana presets",
      description:
        "Lists edit presets: aura-style recipes and the user's saved presets (with their own reference videos). Use for a bare /katana, or to find a preset by style. Browsing never starts a run.",
      inputSchema: z.object({ query: z.string().max(200).optional(), category: z.enum(CATEGORIES).optional() }),
      annotations: { readOnlyHint: true },
      _meta: widgetMeta(WIDGETS.presets),
    },
    safe(async ({ query, category }) => {
      const presets = await listPresets({ query, category });
      const rows = presets.map((p) => [`/katana/${p.slug}`, p.title, p.category.replace("_", " "), p.referencePath ? "yes" : "recipe", p.description]);
      return result(
        presets.length ? table(["Command", "Title", "Category", "Reference", "Description"], rows) : "No presets match.",
        { presets: presets.map(({ dir: _d, referencePath: _r, thumbnailPath: _t, ...p }) => ({ ...p, hasReference: Boolean(_r) })) },
      );
    }),
  );

  server.registerTool(
    "katana_start",
    {
      title: "Start an open-katana project",
      description:
        "Creates a project and imports its media. Give a reference edit (video) and/or a preset, the user's subject images (first = clearest face), and optional music or footage. Returns the project id used by every other tool.",
      inputSchema: z.object({
        reference: media.optional().describe("The reference edit to remix (video path or URL)"),
        preset: z.string().optional().describe("Preset slug, e.g. neon-rain or /katana/neon-rain"),
        subjects: z.array(media).max(10).default([]).describe("Photos of the character, product or outfit; the first should show the face clearly"),
        footage: z.array(media).max(20).default([]).describe("The user's own clips (clip mode, or reusable shots)"),
        music: media.optional().describe("A soundtrack to use instead of the reference's audio"),
        instructions: z.string().max(2000).optional(),
        mode: z.enum(MODES).default("remix"),
        title: z.string().max(80).optional(),
      }),
    },
    safe(async (a) => {
      const preset = a.preset ? await getPreset(a.preset) : undefined;
      if (!a.reference && !preset && !a.footage.length) {
        throw new Error("Give a reference video, a preset or footage. With nothing to work from, call katana_presets and let the user choose.");
      }
      const ws = await Workspace.create({ title: a.title ?? preset?.title ?? "edit", mode: a.mode, preset: preset?.slug, instructions: a.instructions });
      const refSource = a.reference ?? preset?.referencePath;
      if (refSource) await ws.import(refSource, "reference", { id: "ref" });
      for (const s of a.subjects) await ws.import(s, "subject");
      for (const f of a.footage) await ws.import(f, "footage");
      if (a.music) await ws.import(a.music, "audio", { id: "music" });
      if (preset) await ws.writeJson("plan/preset.json", preset);
      const rows = ws.project.assets.map((x) => [x.id, x.role, x.kind, x.width ? `${x.width}×${x.height}` : "", x.durationSec ? `${x.durationSec.toFixed(2)} s` : "", x.label]);
      const next = ws.reference() ? "Next: katana_backend (once per session), then katana_analyze." : "No reference video: plan directly from the preset recipe and the music (katana_plan).";
      const recipe = preset
        ? [
            `\n\nPreset recipe (${preset.title}):\n${JSON.stringify(preset.recipe, null, 1)}`,
            preset.prompt ? `Author context: ${preset.prompt}` : "",
            preset.slots.length ? `Slots to fill:\n${table(["Slot", "Kind", "Description", "Operation", "Guidance"], preset.slots.map((x) => [x.id, x.kind, x.description, x.operation, x.guidance]))}` : "",
            preset.skeleton ? skeletonSummary(preset.skeleton) : "",
          ].filter(Boolean).join("\n\n")
        : "";
      return result(`Project ${ws.project.id} (${ws.project.mode}).\n\n${table(["Asset", "Role", "Kind", "Size", "Length", "Label"], rows)}\n\n${next}${recipe}\n\n${resumeLine(ws)}`, {
        project: ws.project.id,
        mode: ws.project.mode,
        assets: ws.project.assets,
        preset: preset?.slug,
      });
    }),
  );

  server.registerTool(
    "katana_import",
    {
      title: "Import media into a project",
      description: "Adds a file or URL to a project: another subject image, a style reference, footage or music.",
      inputSchema: z.object({ project: z.string(), source: media, role: z.enum(ROLES), id: z.string().regex(/^[a-z0-9_-]{1,24}$/i).optional() }),
    },
    safe(async ({ project, source, role, id }) => {
      const ws = await state.workspace(project);
      const asset = await ws.import(source, role, { id });
      return result(`Imported ${asset.id} (${asset.role}, ${asset.kind}).`, { asset });
    }),
  );

  server.registerTool(
    "katana_status",
    {
      title: "Project status",
      description: "Without a project: lists recent projects. With one: its stage, assets, review progress, jobs and versions, plus a resume line for continuing in a new chat.",
      inputSchema: z.object({ project: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project }) => {
      if (!project) {
        const list = await Workspace.list();
        return result(list.length ? table(["Project", "Title", "Mode", "Stage", "Updated"], list.slice(0, 20).map((p) => [p.id, p.title, p.mode, p.stage, p.updatedAt.slice(0, 16)])) : "No projects yet.", {
          projects: list.slice(0, 20).map((p) => ({ id: p.id, title: p.title, stage: p.stage })),
        });
      }
      const ws = await state.workspace(project);
      const pages = (await ws.readJson<{ page: number }[]>("analysis/pages.json")) ?? [];
      const reviewed = Object.keys(ws.project.reviewedPages).length;
      const jobs = await loadJobs(ws);
      const byState = jobs.reduce<Record<string, number>>((m, j) => ({ ...m, [j.state]: (m[j.state] ?? 0) + 1 }), {});
      const lines = [
        `Project ${ws.project.id} — ${ws.project.title} (${ws.project.mode}), stage: ${ws.project.stage}`,
        `Assets: ${ws.project.assets.map((a) => `${a.id}(${a.role})`).join(", ")}`,
        `Review: ${reviewed}/${pages.length} pages logged`,
        `Jobs: ${jobs.length ? Object.entries(byState).map(([k, v]) => `${v} ${k}`).join(", ") : "none"}`,
        `Versions: ${ws.project.versions.map((v) => `v${v.version} ${v.path}`).join(", ") || "none"}`,
        resumeLine(ws),
      ];
      return result(lines.join("\n"), { project: ws.project, pages: pages.length, reviewed, jobs });
    }),
  );

  server.registerTool(
    "katana_backend",
    {
      title: "ComfyUI backend",
      description:
        "status: checks the configured ComfyUI (local, remote GPU or Comfy Cloud), lists which generation profiles it can run (with download links for missing models), the default profile for each operation with its model licence, and licence warnings. set: changes the backend (kind http with url for local/remote ComfyUI; cloud with apiKey; comfy-cli to reuse the comfy CLI sign-in), the quality tier, per-operation profiles, or commercial.",
      inputSchema: z.object({
        action: z.enum(["status", "set"]).default("status"),
        kind: z.enum(["http", "cloud", "comfy-cli"]).optional(),
        url: z.string().url().optional(),
        apiKey: z
          .string()
          .optional()
          .describe(
            "Comfy Cloud API key (kind cloud) or bearer token for a protected ComfyUI (kind http). It is saved in plain text to ~/.open-katana/config.json. To keep a key out of the chat, set COMFY_CLOUD_API_KEY in the MCP server's environment, or use kind comfy-cli (comfy cloud login).",
          ),
        tier: z.enum(["quality", "lite"]).optional(),
        profiles: z
          .record(z.string(), z.string())
          .optional()
          .describe('Per-operation profile choices, e.g. {"clip.i2v": "minimax-h3-i2v"}; an empty string restores the default'),
        commercial: z
          .boolean()
          .optional()
          .describe("True when the output is for commercial use: defaults skip models with non-commercial licences, and restricted ones are flagged. Profiles chosen by name still run, with a warning."),
      }),
    },
    safe(async ({ action, kind, url, apiKey, tier, profiles, commercial }) => {
      let envNote = "";
      if (action === "set") {
        const cfg = await state.config();
        const nextProfiles = { ...cfg.profiles };
        for (const [op, id] of Object.entries(profiles ?? {})) {
          if (!id) delete nextProfiles[op];
          else if (!PROFILES.some((p) => p.id === id && p.operation === op)) throw new Error(`${id} is not a ${op} profile`);
          else nextProfiles[op] = id;
        }
        // A url or apiKey without a kind applies to the saved backend's kind.
        const nextKind = kind ?? (url || apiKey ? cfg.backend?.kind : undefined);
        if ((url || apiKey) && !nextKind) throw new Error("Give kind (http, cloud or comfy-cli) along with url or apiKey.");
        await state.updateConfig({
          ...(nextKind ? { backend: nextBackend(cfg.backend, { kind: nextKind, url, apiKey }) } : {}),
          ...(tier ? { tier } : {}),
          ...(commercial !== undefined ? { commercial } : {}),
          profiles: nextProfiles,
        });
        // The server's environment wins over config.json, so a newly saved backend may not be the one in use.
        const env = backendEnvOverrides();
        if (nextKind && env.length) {
          const vars = env.length > 1 ? `${env.slice(0, -1).join(", ")} and ${env.at(-1)}` : env[0];
          envNote = `Saved, but ${vars} in the server's environment ${env.length > 1 ? "override" : "overrides"} the saved backend. Remove ${env.length > 1 ? "them" : "it"} from the MCP server's env (or the shell that starts it) and restart the server to use the saved one.\n\n`;
        }
      }
      const backend = await state.backend();
      const cfg = await state.config();
      const check = await backend.check();
      const catalog = check.ok ? await backend.catalog().catch(() => undefined) : undefined;
      const licences = licenceReport(cfg, catalog, backend.onDemandModels);
      const licenceData = { commercial: Boolean(cfg.commercial), active: licences.active, licenseWarnings: licences.warnings };
      if (!check.ok) return result(`${envNote}Backend ${backend.target} is not usable: ${check.detail}\n\n${licences.text}`, { check, ...licenceData });
      const rows = PROFILES.map((p) => {
        const base = { profile: p.id, operation: p.operation, tier: p.tier, license: licenseLabel(p.license) };
        if (!catalog) return { ...base, status: "unknown", missing: "" };
        const a = checkProfile(p, catalog);
        if (backend.onDemandModels && !a.missingNodes.length) {
          // Comfy Cloud fetches unlisted model files when a job uses them.
          return { ...base, status: "ready", missing: a.missingModels.length ? `on demand: ${a.missingModels.join(", ")}` : "" };
        }
        const links = p.models.filter((m) => a.missingModels.includes(`${m.folder}/${m.name}`)).map((m) => `${m.folder}/${m.name} ← ${m.url}`);
        return { ...base, status: a.runnable ? "ready" : "missing", missing: [...links, ...a.missingNodes.map((n) => `node ${n}`)].join("; ") };
      });
      const chosen = Object.entries(cfg.profiles).map(([op, id]) => `${op} → ${id}`).join(", ");
      return result(
        `${envNote}Backend ${backend.target}: ${check.detail}${check.version ? ` (ComfyUI ${check.version})` : ""}. Tier: ${cfg.tier}.${chosen ? ` Chosen profiles: ${chosen}.` : ""}\n\n${licences.text}\n\n${table(["Profile", "Operation", "Tier", "Licence", "Status", "Missing"], rows.map((r) => [r.profile, r.operation, r.tier, r.license, r.status, r.missing]))}`,
        { check, tier: cfg.tier, ...licenceData, profiles: rows.map((r) => ({ profile: r.profile, status: r.status, license: r.license })) },
      );
    }),
  );

  server.registerTool(
    "katana_preset_save",
    {
      title: "Save a preset",
      description:
        "Saves a reusable preset to the user's library: a reference edit (3–30 s, video), optional example images (≤40), a title, category and the creative prompt (mention images as @image1, @image2…).",
      inputSchema: z.object({
        slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        title: z.string().max(80),
        description: z.string().max(300),
        category: z.enum(CATEGORIES),
        prompt: z.string().max(4000).default(""),
        reference: media.optional().describe("Reference video path (or omit and give project to reuse its reference)"),
        project: z.string().optional(),
        images: z.array(z.string()).max(40).default([]),
        recipe: PresetSchema.shape.recipe.optional(),
      }),
    },
    safe(async (a) => {
      let reference = a.reference;
      if (!reference && a.project) {
        const ws = await state.workspace(a.project);
        const ref = ws.reference();
        if (ref) reference = ws.path(ref.path);
      }
      const saved = await savePreset(
        PresetSchema.parse({ slug: a.slug, title: a.title, description: a.description, category: a.category, prompt: a.prompt, recipe: a.recipe, author: "user" }),
        { reference, images: a.images },
      );
      return result(`Saved preset /katana/${saved.slug}${saved.referencePath ? " with its reference video" : ""}.`, { slug: saved.slug });
    }),
  );
}
