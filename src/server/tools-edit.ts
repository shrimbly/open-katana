import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { EnergyMap } from "../engine/energy.js";
import { sampleSheet } from "../engine/sheets.js";
import { edlBeats, renderProject } from "../project/render-project.js";
import { slugify, type Workspace } from "../project/workspace.js";
import { deliver } from "../render/deliver.js";
import { checkEdl, type Edl, EdlSchema, resolveTime } from "../render/edl.js";
import { checkRender } from "../render/qa.js";
import { BUILTIN_SFX } from "../render/sfx.js";
import { image, result, safe, table } from "./content.js";
import type { State } from "./state.js";
import { verdicts } from "./tools-generate.js";
import { WIDGETS, widgetMeta } from "./widgets.js";

const COLOR = /^(black|white|#[0-9a-fA-F]{6})$/;
const edlDuration = (frames: number, fps?: number) => (fps ? +(frames / fps).toFixed(3) : undefined);

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
      let edl = given;
      let fromSkeleton = false;
      if (!edl && fromPreset) {
        const preset = await ws.readJson<{ skeleton?: unknown }>("plan/preset.json");
        if (!preset?.skeleton) throw new Error("This project's preset has no edit skeleton; write the EDL yourself.");
        let text = JSON.stringify(preset.skeleton);
        const used = [...new Set([...text.matchAll(/"slot:([a-z0-9_-]+)"/g)].map((m) => m[1]!))];
        const missing = used.filter((id) => !fromPreset.slots[id]);
        if (missing.length) throw new Error(`Fill every slot the skeleton uses. Missing: ${missing.join(", ")}.`);
        for (const id of used) {
          ws.asset(fromPreset.slots[id]!);
          text = text.replaceAll(`"slot:${id}"`, JSON.stringify(fromPreset.slots[id]));
        }
        edl = EdlSchema.parse(JSON.parse(text));
        if (fromPreset.audio && edl.audio) edl.audio.asset = fromPreset.audio;
        fromSkeleton = true;
      }
      if (!edl) throw new Error("Give an edl, or fromPreset with the slot assets.");
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
          warnings.length ? `Warnings:\n- ${warnings.join("\n- ")}` : "No warnings.",
          fromSkeleton ? `Built from the preset skeleton. Adapt the wording to this user and fix anything that doesn't fit, then save the changed EDL with katana_edit:\n${JSON.stringify(edl)}` : "",
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
