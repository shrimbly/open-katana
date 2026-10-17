import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fitTrack } from "../app/music.js";
import { type AudioAnalysis, analyzeAudio } from "../engine/audio.js";
import type { EnergyMap } from "../engine/energy.js";
import { sampleSheet } from "../engine/sheets.js";
import { applyBrief, checkWords } from "../presets/brief.js";
import { getPreset, type Preset, soundtrackPath } from "../presets/library.js";
import { edlBeats, renderProject } from "../project/render-project.js";
import { slugify, type Workspace } from "../project/workspace.js";
import { deliver } from "../render/deliver.js";
import { checkEdl, type Edl, EdlSchema, resolveTime } from "../render/edl.js";
import { checkRender } from "../render/qa.js";
import { BUILTIN_SFX } from "../render/sfx.js";
import { isAppRun, readBrief, refuseIfLocked, refuseInAppRun, userPicks } from "./app-mode.js";
import { image, result, safe, table } from "./content.js";
import type { State } from "./state.js";
import { verdicts } from "./tools-generate.js";
import { WIDGETS, widgetMeta } from "./widgets.js";

const COLOR = /^(black|white|#[0-9a-fA-F]{6})$/;
const edlDuration = (frames: number, fps?: number) => (fps ? +(frames / fps).toFixed(3) : undefined);

/** The soundtrack must exist now, not only at render: audio "ref" needs a reference video. */
function checkAudio(ws: Workspace, edl: Edl): void {
  if (edl.audio?.asset !== "ref" || ws.reference()) return;
  const music = ws.project.assets.some((a) => a.id === "music");
  throw new Error(`This project has no reference video, so audio "ref" has no sound.${music ? ' Use audio "music".' : " Import a track (asset music) or use a silent edit."}`);
}

async function validate(ws: Workspace, edl: Edl, beats: number[]): Promise<string[]> {
  const warnings = checkEdl(edl, { fps: edl.canvas.fps, beats }).warnings;
  const vs = await verdicts(ws);
  for (const [i, shot] of edl.shots.entries()) {
    const id = shot.source.asset;
    if (COLOR.test(id)) continue;
    const asset = ws.asset(id);
    const v = vs.find((x) => x.asset === id);
    if (v?.verdict === "reject") warnings.push(`Shot ${shot.id ?? i} uses ${id}, which you rejected (${v.reason ?? "no reason"}).`);
    if (asset.kind === "video" && asset.durationSec) {
      const dur = resolveTime(shot.end, { fps: edl.canvas.fps, beats }) - resolveTime(shot.start, { fps: edl.canvas.fps, beats });
      const span = shot.source.speed === 0 ? 0 : dur * ((shot.source.speed + (shot.source.speedTo ?? shot.source.speed)) / 2);
      const end = shot.source.in + span;
      if (end > asset.durationSec + 0.05) warnings.push(`Shot ${shot.id ?? i}: ${id} runs out at ${asset.durationSec.toFixed(2)} s (needs ${end.toFixed(2)} s); the last frame will hold.`);
      for (const [a, b] of v?.badRanges ?? []) {
        if (shot.source.in < b && end > a) warnings.push(`Shot ${shot.id ?? i} uses ${id} ${shot.source.in.toFixed(2)}–${end.toFixed(2)} s, overlapping its bad range ${a}–${b} s.`);
      }
    }
  }
  if (edl.audio && edl.audio.asset !== "ref") ws.asset(edl.audio.asset);
  for (const cue of edl.sfx) {
    if (!BUILTIN_SFX[cue.sound]) {
      const a = ws.asset(cue.sound);
      if (a.kind === "image") warnings.push(`SFX ${cue.sound} is an image, not a sound.`);
    }
  }
  return warnings;
}

/**
 * The person's take picks (made in the app) are final: every picture source in the edit that is an
 * output of a picked line must be the pick. Returns one problem per offending source.
 */
async function pickProblems(ws: Workspace, edl: Edl): Promise<string[]> {
  const picks = await userPicks(ws);
  if (!picks.size) return [];
  const sources: string[] = [];
  for (const shot of edl.shots) {
    sources.push(shot.source.asset, ...(shot.source.matte ? [shot.source.matte] : []));
    for (const layer of shot.layers ?? []) sources.push(layer.source.asset, ...(layer.source.matte ? [layer.source.matte] : []));
  }
  const problems = new Set<string>();
  for (const id of sources) {
    const line = ws.project.assets.find((a) => a.id === id)?.lineId;
    const pick = line ? picks.get(line) : undefined;
    if (pick && pick !== id) problems.add(`[USER_PICK] Use ${pick} instead of ${id} (the person's pick for line ${line}).`);
  }
  return [...problems];
}

const APP_SKELETON_NOTE = "Built from the skeleton with the person's words, soundtrack and grid already applied. Keep the words exactly; adjust only takes or timing if needed.";

/** The project's preset entry (with its folder), when it still exists. */
async function projectPreset(ws: Workspace) {
  return ws.project.preset ? getPreset(ws.project.preset).catch(() => undefined) : undefined;
}

/**
 * The template's own track as asset "music", when the brief names it and the project lacks it (a project
 * made before the app imported it). The file is the template's, so nothing the person gave is touched.
 */
async function ensureTemplateTrack(ws: Workspace): Promise<boolean> {
  if (ws.project.assets.some((a) => a.id === "music")) return false;
  const preset = await projectPreset(ws);
  const file = preset ? soundtrackPath(preset) : undefined;
  if (!file) return false;
  await ws.import(file, "audio", { id: "music", label: preset!.soundtrack!.title });
  return true;
}

/**
 * A chat edit built from a skeleton timed to the template's track but played on the person's own music:
 * the grid, length and start offset are refitted to that track (as the app does in plan/brief.json), so
 * "b<n>" cuts land on its beats. Returns a line for the result, or undefined when nothing changed.
 */
async function fitToMusic(ws: Workspace, edl: Edl, preset: Pick<Preset, "timing" | "skeleton" | "soundtrack"> & { dir?: string }): Promise<string | undefined> {
  if (edl.audio?.asset !== "music" || !edl.grid) return undefined;
  const music = ws.asset("music");
  const bundled = preset.dir ? soundtrackPath({ dir: preset.dir, soundtrack: preset.soundtrack }) : undefined;
  if (bundled && music.source === bundled) return undefined;
  let track = await ws.readJson<AudioAnalysis>("analysis/audio-music.json");
  if (!track) {
    track = await analyzeAudio(ws.assetPath("music"));
    await ws.writeJson("analysis/audio-music.json", track);
  }
  const grid = { bpm: edl.grid.bpm, phase: edl.grid.phase ?? 0 };
  const durationSec = edl.canvas.durationSec ?? (preset.skeleton as { canvas?: { durationSec?: number } } | undefined)?.canvas?.durationSec;
  if (!durationSec) return undefined;
  const fit = fitTrack(track, { grid, ...(preset.timing?.dropBeat !== undefined ? { dropBeat: preset.timing.dropBeat } : {}), durationSec }, true);
  if (!fit.ok) return `The track has no steady beat: the cut keeps the template's ${grid.bpm} BPM grid.`;
  edl.grid = { ...edl.grid, ...fit.grid };
  edl.canvas = { ...edl.canvas, durationSec: fit.durationSec };
  edl.audio = { ...edl.audio, offset: fit.offsetSec };
  return `Retimed to the music: ${fit.bpm} BPM grid (was the template's ${grid.bpm}), ${fit.durationSec} s, the track starts at ${fit.offsetSec} s${fit.aligned ? " so its drop lands on the big moment" : ""}.`;
}

export function registerEditTools(server: McpServer, state: State): void {
  server.registerTool(
    "katana_studio",
    {
      title: "Open the editor",
      description:
        "Starts the open-katana studio (a local timeline editor) and returns its link for a project: the user can see every shot, text layer, flash and sound effect on the timeline, edit text and timing, swap clips and re-render. Their saved changes land in the same EDL you edit with katana_edit.",
      inputSchema: z.object({ project: z.string() }),
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project }) => {
      refuseInAppRun();
      const ws = await state.workspace(project);
      const { ensureStandaloneStudio } = await import("../studio/server.js");
      const url = await ensureStandaloneStudio(ws.project.id);
      return result(`Studio for ${ws.project.title}: ${url}`, { url, project: ws.project.id });
    }),
  );

  server.registerTool(
    "katana_edit",
    {
      title: "Write the edit",
      description:
        'Saves the edit decision list: canvas, soundtrack, shots on the timeline (source asset, in-point, speed/ramps/freeze/reverse, camera moves, per-shot effects), timeline flashes, text and the finish. Times are seconds, "b<n>" beats of the soundtrack or "f<n>" frames. Returns the resolved timeline and warnings. Asset "ref" is the reference; colours "black", "white", "#rrggbb" make solid frames.',
      inputSchema: z.object({
        project: z.string(),
        edl: EdlSchema.optional(),
        fromPreset: z
          .object({
            /** Accepted asset for every slot the preset's skeleton uses, e.g. { "walk": "c_walk_t2" }. */
            slots: z.record(z.string(), z.string()),
            /** Soundtrack asset to use instead of the skeleton's (default "ref"). */
            audio: z.string().optional(),
          })
          .optional()
          .describe("Build the edit from the project's preset skeleton, filling its slots with accepted assets. The result shows the full EDL so you can adjust it (wording, takes, timing) with a second katana_edit."),
      }),
    },
    safe(async ({ project, edl: given, fromPreset }) => {
      const ws = await state.workspace(project);
      refuseIfLocked(ws);
      const brief = await readBrief(ws);
      let edl = given;
      let fromSkeleton = false;
      const notes: string[] = [];
      if (!edl && fromPreset) {
        const preset = await ws.readJson<Pick<Preset, "skeleton" | "timing" | "soundtrack">>("plan/preset.json");
        if (!preset?.skeleton) throw new Error("This project's preset has no edit skeleton; write the EDL yourself.");
        let text = JSON.stringify(preset.skeleton);
        const used = [...new Set([...text.matchAll(/"slot:([a-z0-9_-]+)"/g)].map((m) => m[1]!))];
        const missing = used.filter((id) => !fromPreset.slots[id]);
        if (missing.length) throw new Error(`Fill every slot the skeleton uses. Missing: ${missing.join(", ")}.`);
        for (const id of used) {
          ws.asset(fromPreset.slots[id]!);
          const asset = JSON.stringify(fromPreset.slots[id]);
          text = text.replaceAll(`"slot:${id}"`, () => asset);
        }
        // The person's words, colours, soundtrack and grid from the app (plan/brief.json).
        const filled = JSON.parse(text) as Record<string, unknown>;
        edl = EdlSchema.parse(brief ? applyBrief(filled, brief) : filled);
        if (fromPreset.audio && edl.audio) edl.audio.asset = fromPreset.audio;
        // The template's own track, when the brief names it but it never reached the project.
        if (edl.audio?.asset === "music" && brief?.audio?.asset === "music" && (await ensureTemplateTrack(ws))) notes.push("Imported the template's track as asset music.");
        // A skeleton timed to its reference's sound, in a project without a reference: use the project's music.
        if (edl.audio?.asset === "ref" && !ws.reference() && !fromPreset.audio && ws.project.assets.some((x) => x.id === "music")) edl.audio.asset = "music";
        // Chat: without the app's brief, the skeleton's grid is the template's tempo; refit it to the person's own music.
        if (!brief) {
          const entry = await projectPreset(ws);
          const line = await fitToMusic(ws, edl, { ...(preset ?? {}), ...(entry ? { dir: entry.dir, soundtrack: entry.soundtrack } : {}) });
          if (line) notes.push(line);
        }
        fromSkeleton = true;
      }
      if (!edl) throw new Error("Give an edl, or fromPreset with the slot assets.");
      const picks = await pickProblems(ws, edl);
      if (picks.length) throw new Error(picks.join("\n"));
      if (isAppRun() && brief) {
        const words = checkWords(edl, brief);
        if (words.length) throw new Error(`[WORDS] ${words.join(" ")}`);
      }
      checkAudio(ws, edl);
      const beats = await edlBeats(ws, edl);
      const warnings = await validate(ws, edl, beats);
      await ws.writeJson("render/edl.json", edl);
      await ws.setStage("assembling");
      const check = checkEdl(edl, { fps: edl.canvas.fps, beats });
      const rows = check.shots.map((s) => [
        s.shot.id ?? s.index,
        s.startSec.toFixed(3),
        s.endSec.toFixed(3),
        s.frames,
        s.shot.source.asset,
        s.shot.source.in,
        s.shot.source.speed === 0 ? "freeze" : `${s.shot.source.speed}${s.shot.source.speedTo !== undefined ? `→${s.shot.source.speedTo}` : ""}`,
        Object.keys(s.shot.camera ?? {}).filter((k) => k !== "ease").join(" "),
        Object.keys(s.shot.fx ?? {}).join(" "),
      ]);
      return result(
        [
          `Edit saved: ${check.shots.length} shots, ${check.totalFrames} frames (${check.durationSec.toFixed(2)} s at ${edl.canvas.fps} fps), ${edl.flashes.length} flashes, ${edl.text.length} text cards.`,
          table(["Shot", "Start", "End", "Frames", "Source", "In", "Speed", "Camera", "FX"], rows),
          ...notes,
          warnings.length ? `Warnings:\n- ${warnings.join("\n- ")}` : "No warnings.",
          fromSkeleton
            ? isAppRun()
              ? `${APP_SKELETON_NOTE} To change anything, save the changed EDL with katana_edit:\n${JSON.stringify(edl)}`
              : `Built from the preset skeleton. Adapt the wording to this user and fix anything that doesn't fit, then save the changed EDL with katana_edit:\n${JSON.stringify(edl)}`
            : "",
          "Next: katana_render with preview: true.",
        ].join("\n\n"),
        { frames: check.totalFrames, durationSec: check.durationSec, warnings },
      );
    }),
  );

  server.registerTool(
    "katana_render",
    {
      title: "Render the edit",
      description:
        "Renders the saved edit with ffmpeg. preview (default) is half resolution and fast; final writes the master. Unchanged shots come from the cache, so text, timing and grade changes re-render quickly. Returns a frame sheet, technical checks and the energy comparison with the reference.",
      inputSchema: z.object({ project: z.string(), preview: z.boolean().default(true) }),
    },
    safe(async ({ project, preview }) => {
      const ws = await state.workspace(project);
      refuseIfLocked(ws);
      const edl = await ws.readJson("render/edl.json", EdlSchema);
      if (!edl) throw new Error("No edit saved yet. Use katana_edit.");
      const name = preview ? "preview" : "master";
      const r = await renderProject(ws, name, edl);
      const sheet = ws.path("render", `${name}-sheet.jpg`);
      await sampleSheet({ input: r.path, outPath: sheet, aspect: r.width / r.height, fps: r.fps, durationSec: r.durationSec, everySec: Math.min(0.5, Math.max(0.1, r.durationSec / 36)) });
      const reference = ws.reference() ? await ws.readJson<EnergyMap>("analysis/energy.json") : undefined;
      const qa = await checkRender(r.path, { frames: r.frames, width: r.width, height: r.height, audio: Boolean(edl.audio) && !r.warnings.some((w) => w.includes("silent")) }, reference);
      if (!preview) await ws.setStage("rendered");
      const energy = qa.energy
        ? `Energy vs reference (need ≥ ${qa.energy.min}×): ${qa.energy.pass ? "PASS" : "FAIL"}\n${table(["Measure", "Reference", "Ours", "Ratio", "Status", "Fix"], qa.energy.rows.map((x) => [x.measure, x.reference, x.ours, x.ratio ?? "", x.status, x.fix ?? ""]))}`
        : "No reference energy to compare.";
      return result(
        [
          `Rendered ${name}: ${r.width}×${r.height}, ${r.frames} frames, ${r.durationSec.toFixed(2)} s, ${qa.sizeMB} MB in ${r.elapsedSec.toFixed(1)} s (${r.shotsRendered} shots rendered, ${r.shotsCached} from cache). File: ${r.path}`,
          qa.issues.length ? `Issues:\n- ${qa.issues.join("\n- ")}` : "Technical checks passed.",
          r.warnings.length ? `Warnings:\n- ${r.warnings.join("\n- ")}` : "",
          energy,
          preview ? "Inspect the sheet; fix the edit, then render with preview: false." : "Inspect the sheet, then katana_deliver.",
        ].filter(Boolean).join("\n\n"),
        { path: r.path, frames: r.frames, issues: qa.issues, energy: qa.energy },
        [await image(sheet)],
      );
    }),
  );

  server.registerTool(
    "katana_deliver",
    {
      title: "Deliver the edit",
      description: "Exports the final master as a numbered version (size-capped MP4 for sharing) and returns its path. Render with preview: false first.",
      inputSchema: z.object({ project: z.string(), note: z.string().max(300).optional(), maxMB: z.number().positive().max(500).default(50) }),
      _meta: widgetMeta(WIDGETS.result),
    },
    safe(async ({ project, note, maxMB }) => {
      const ws = await state.workspace(project);
      refuseIfLocked(ws);
      const master = ws.path("render", "master.mp4");
      const edlFile = ws.path("render", "edl.json");
      if (!existsSync(master)) throw new Error("No final render yet. Use katana_render with preview: false.");
      if (existsSync(edlFile) && statSync(edlFile).mtimeMs > statSync(master).mtimeMs) throw new Error("The edit changed after the last final render. Render again with preview: false.");
      const version = ws.project.versions.length + 1;
      const out = ws.path("deliver", `${slugify(ws.project.title)}_v${version}.mp4`);
      const d = await deliver(master, out, maxMB);
      ws.project.versions.push({ version, path: ws.rel(out), createdAt: new Date().toISOString(), note });
      await ws.save();
      await ws.setStage("delivered");
      const rel = ws.rel(out);
      return result(`Delivered v${version}: ${out} (${d.sizeMB} MB, ${d.frames} frames${d.reencoded ? ", re-encoded to fit" : ""}).`, {
        project: ws.project.id,
        version,
        path: out,
        uri: `katana://media/${ws.project.id}/${rel}`,
        sizeMB: d.sizeMB,
        frames: d.frames,
        durationSec: edlDuration(d.frames, (await ws.readJson("render/edl.json", EdlSchema))?.canvas.fps),
        title: ws.project.title,
        versions: ws.project.versions.map((v) => ({ version: v.version, uri: `katana://media/${ws.project.id}/${v.path}`, note: v.note })),
      });
    }),
  );
}
