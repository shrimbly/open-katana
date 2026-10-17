import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Breakdown } from "../engine/analyze.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { EnergyMap } from "../engine/energy.js";
import { everyFramePages, frameSheet, sampleSheet } from "../engine/sheets.js";
import { analyzeProject, hashCode, type StoredPage } from "../project/analysis.js";
import type { Workspace } from "../project/workspace.js";
import { refuseIfLocked } from "./app-mode.js";
import { type Content, image, result, safe, table } from "./content.js";
import type { State } from "./state.js";

export async function referenceBeats(ws: Workspace): Promise<number[]> {
  return (await ws.readJson<AudioAnalysis>("analysis/audio.json"))?.beats ?? [];
}

/** The reference's shot list after the agent's corrections, falling back to the detector's. */
export async function referenceShots(ws: Workspace): Promise<Breakdown["shots"]> {
  return (await ws.readJson<Breakdown["shots"]>("analysis/shots.json")) ?? (await ws.readJson<Breakdown>("analysis/breakdown.json"))?.shots ?? [];
}

async function videoSheet(ws: Workspace, assetId: string, everySec: number): Promise<string> {
  const a = ws.asset(assetId);
  const out = ws.path("qa", `${assetId}-${everySec}.jpg`);
  if (!existsSync(out)) {
    await sampleSheet({ input: ws.path(a.path), outPath: out, aspect: (a.width ?? 16) / (a.height ?? 9), fps: a.fps ?? 24, durationSec: a.durationSec ?? 1, everySec });
  }
  return out;
}

export function registerAnalysisTools(server: McpServer, state: State): void {
  server.registerTool(
    "katana_analyze",
    {
      title: "Analyze the reference",
      description:
        "Measures the reference edit: format, shots (cuts, flash-hidden cuts, dissolves, one-frame inserts), flashes and glow pulses, camera moves, shake, zoom punches, beats and onsets, and builds every-frame review pages. Returns a summary and the overview sheet (one frame per shot). Next: open every review page with katana_view.",
      inputSchema: z.object({ project: z.string(), force: z.boolean().default(false).describe("Re-run even if an analysis exists") }),
    },
    safe(async ({ project, force }) => {
      const ws = await state.workspace(project);
      if (force) refuseIfLocked(ws);
      // The app's decode runs the same analysis first, so in app runs this only reads it back.
      await analyzeProject(ws, { force });
      const breakdown = (await ws.readJson<Breakdown>("analysis/breakdown.json"))!;
      const pages = (await ws.readJson<StoredPage[]>("analysis/pages.json"))!;
      const energy = (await ws.readJson<EnergyMap>("analysis/energy.json"))!;
      const audio = await ws.readJson<AudioAnalysis>("analysis/audio.json");
      const f = breakdown.format;
      const shots = breakdown.shots.map((s) => [s.index, s.startFrame, s.frames, s.startSec.toFixed(3), s.durationSec.toFixed(3), s.transitionIn]);
      const fx = energy.events
        .filter((e) => e.type !== "cut" && e.type !== "hit")
        .slice(0, 60)
        .map((e) => [e.type, e.direction ?? "", e.startSec.toFixed(2), e.endSec.toFixed(2), e.intensity]);
      const summary = [
        `Reference: ${f.width}×${f.height}, ${f.fpsValue} fps, ${f.frameCount} frames, ${f.durationSec} s${f.variableFrameRate ? " (variable frame rate)" : ""}, audio: ${f.hasAudio ? "yes" : "no"}.`,
        audio ? `Music: ~${audio.tempoBpm} BPM (confidence ${audio.tempoConfidence}), ${audio.beats.length} beats tracked (b0 = ${audio.beats[0] ?? "–"} s), ${audio.onsets.length} onsets.` : "No audio analysis.",
        `Energy: ${energy.summary.cutsPerSecond} cuts/s, mean shot ${energy.summary.meanShotSec} s, ${energy.summary.flashesPerSecond} flashes/s, ${energy.summary.cameraMoveSeconds} s of camera moves, ${energy.summary.shakeSeconds} s of shake, ${Math.round(energy.summary.cutsOnBeatShare * 100)}% of cuts on beats/hits.`,
        "",
        `Shots (detector proposal — verify on the pages):\n${table(["Shot", "Start frame", "Frames", "Start s", "Duration s", "In"], shots)}`,
        "",
        `Effects and camera:\n${fx.length ? table(["Type", "Direction", "Start", "End", "Intensity"], fx) : "none detected"}`,
        "",
        `Review: ${pages.length} pages of every native frame. Open them in order with katana_view {target: "page", pages: [...]} (up to 3 per call), then log them with katana_review.`,
      ].join("\n");
      return result(summary, { format: f, shots: breakdown.shots, flashes: breakdown.flashes, energy: energy.summary, beats: audio?.beats, pages: pages.length }, [await image(ws.path("analysis", "overview.jpg"))]);
    }),
  );

  server.registerTool(
    "katana_view",
    {
      title: "View frames",
      description:
        'Shows images. target "page": every-frame review pages (pages: up to 3 numbers). "overview": one frame per reference shot. "shot": every frame of one reference shot. "frames": specific reference frames. "asset": a project image, or a sheet of a video asset sampled every everySec. "render": a sheet of the latest render. "render-pages": every frame of the latest render, one second per page (pages: up to 3) — use it to inspect the whole output before delivery. "compare": an asset next to the subject photo (or next to `with`), to judge identity.',
      inputSchema: z.object({
        project: z.string(),
        target: z.enum(["page", "overview", "shot", "frames", "asset", "render", "render-pages", "compare"]),
        with: z.string().optional().describe('For "compare": the asset to compare against (default: the first subject photo).'),
        pages: z.array(z.number().int().positive()).max(3).optional(),
        shot: z.number().int().nonnegative().optional(),
        frames: z.array(z.number().int().nonnegative()).max(40).optional(),
        asset: z.string().optional(),
        everySec: z.number().positive().max(2).default(0.25),
      }),
      annotations: { readOnlyHint: true },
    },
    safe(async (a) => {
      const ws = await state.workspace(a.project);
      const images: Content[] = [];
      const notes: string[] = [];
      const ref = ws.reference();
      const breakdown = await ws.readJson<Breakdown>("analysis/breakdown.json");
      const labels = breakdown ? { t0: 0, shotStarts: (await referenceShots(ws)).slice(1).map((s) => s.startFrame) } : undefined;
      switch (a.target) {
        case "page": {
          const pages = (await ws.readJson<StoredPage[]>("analysis/pages.json")) ?? [];
          if (!pages.length) throw new Error("Run katana_analyze first.");
          for (const n of a.pages ?? [1]) {
            const p = pages.find((x) => x.page === n);
            if (!p) throw new Error(`No page ${n}; pages run 1–${pages.length}.`);
            const fps = breakdown?.format.fpsValue ?? 24;
            notes.push(`Page ${n}/${pages.length}: frames ${p.startFrame}–${p.endFrame - 1} (${(p.startFrame / fps).toFixed(2)}–${(p.endFrame / fps).toFixed(2)} s)`);
            images.push(await image(p.path));
          }
          break;
        }
        case "overview":
          images.push(await image(ws.path("analysis", "overview.jpg")));
          break;
        case "shot": {
          if (!ref || !breakdown) throw new Error("Run katana_analyze first.");
          const shots = await referenceShots(ws);
          const s = shots.find((x) => x.index === a.shot);
          if (!s) throw new Error(`No shot ${a.shot}; shots run 0–${shots.length - 1}.`);
          const dir = ws.path("analysis", "shot-sheets", `s${s.index}-${s.startFrame}-${s.endFrame}`);
          const sheet = existsSync(dir)
            ? undefined
            : await everyFramePages({ input: ws.path(ref.path), outDir: dir, aspect: breakdown.format.aspect, framesPerPage: 30, startFrame: s.startFrame, endFrame: s.endFrame, seed: "shot", label: labels });
          const files = sheet?.map((p) => p.path) ?? (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => `${dir}/${f}`);
          for (const file of files.slice(0, 3)) images.push(await image(file));
          notes.push(`Shot ${s.index}: frames ${s.startFrame}–${s.endFrame - 1}, ${s.durationSec} s`);
          break;
        }
        case "frames": {
          if (!ref || !breakdown) throw new Error("Run katana_analyze first.");
          const frames = a.frames ?? [];
          const key = createHash("sha1").update(frames.join(",")).digest("hex").slice(0, 10);
          const out = ws.path("analysis", `frames-${key}.jpg`);
          if (!existsSync(out)) await frameSheet({ input: ws.path(ref.path), outPath: out, aspect: breakdown.format.aspect, frames, label: labels });
          images.push(await image(out));
          break;
        }
        case "asset": {
          if (!a.asset) throw new Error("Give asset.");
          const asset = ws.asset(a.asset);
          if (asset.kind === "image") images.push(await image(ws.path(asset.path)));
          else if (asset.kind === "video") images.push(await image(await videoSheet(ws, asset.id, a.everySec)));
          else throw new Error("Audio assets have nothing to look at.");
          notes.push(`${asset.id}: ${asset.kind}${asset.width ? ` ${asset.width}×${asset.height}` : ""}${asset.durationSec ? `, ${asset.durationSec.toFixed(2)} s at ${asset.fps?.toFixed(2)} fps` : ""}`);
          break;
        }
        case "compare": {
          if (!a.asset) throw new Error("Give asset.");
          const { identityPanel } = await import("./identity.js");
          const panel = await identityPanel(ws, a.asset, a.with);
          if (!panel) throw new Error("No subject photo to compare with; pass `with`.");
          images.push(await image(panel));
          notes.push(`${a.asset} next to ${a.with ?? ws.subjects()[0]?.id}. Same person? Check face shape, skin tone, jaw, eyes, hairline and eyewear.`);
          break;
        }
        case "render-pages": {
          const file = ["render/master.mp4", "render/preview.mp4"].map((r) => ws.path(r)).find((p) => existsSync(p));
          if (!file) throw new Error("Nothing rendered yet. Use katana_render.");
          const { probe } = await import("../engine/probe.js");
          const info = await probe(file);
          const fps = info.video ? info.video.fps.num / info.video.fps.den : 24;
          const stamp = `${statSync(file).mtimeMs.toFixed(0)}`;
          const dir = ws.path("render", `pages-${file.endsWith("master.mp4") ? "master" : "preview"}-${stamp}`);
          const pages = existsSync(dir)
            ? (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort().map((f, i) => ({ page: i + 1, path: join(dir, f) }))
            : await everyFramePages({ input: file, outDir: dir, aspect: (info.video?.displayWidth ?? 16) / (info.video?.displayHeight ?? 9), framesPerPage: Math.min(30, Math.round(fps)), endFrame: info.video?.frameCount ?? 0, seed: "render" });
          for (const n of a.pages ?? [1]) {
            const p = pages.find((x) => x.page === n);
            if (!p) throw new Error(`No render page ${n}; pages run 1–${pages.length}.`);
            images.push(await image(p.path));
          }
          notes.push(`${file.endsWith("master.mp4") ? "Master" : "Preview"} render: ${pages.length} pages (one second each).`);
          break;
        }
        case "render": {
          const sheets = ["render/master-sheet.jpg", "render/preview-sheet.jpg"].map((r) => ws.path(r)).filter((p) => existsSync(p));
          if (!sheets.length) throw new Error("Nothing rendered yet. Use katana_render.");
          images.push(await image(sheets[0]!));
          break;
        }
      }
      return result(notes.join("\n") || `${a.target} view`, undefined, images);
    }),
  );

  server.registerTool(
    "katana_review",
    {
      title: "Log the review",
      description:
        "Records which review pages you read (page number + the CHECK code printed on it), your per-second notes, and corrections to the detected cuts (frame numbers where a shot starts). Generation stays locked until every page is logged.",
      inputSchema: z.object({
        project: z.string(),
        pages: z.array(z.object({ page: z.number().int().positive(), code: z.string().length(4) })).default([]),
        notes: z.string().max(20000).optional().describe("Per-second notes: content, subject and camera motion, text and its style, effects, audio events"),
        addCuts: z.array(z.number().int().positive()).default([]).describe("Frames where a missed shot starts"),
        removeCuts: z.array(z.number().int().positive()).default([]).describe("Detected shot starts that are not real cuts (flashes, glow pulses)"),
      }),
    },
    safe(async (a) => {
      const ws = await state.workspace(a.project);
      refuseIfLocked(ws);
      const pages = (await ws.readJson<StoredPage[]>("analysis/pages.json")) ?? [];
      if (!pages.length) throw new Error("Run katana_analyze first.");
      const wrong: number[] = [];
      for (const { page, code } of a.pages) {
        const p = pages.find((x) => x.page === page);
        if (p && p.codeHash === hashCode(ws.project.id, code)) ws.project.reviewedPages[String(page)] = code.toUpperCase();
        else wrong.push(page);
      }
      if (a.notes) await appendFile(ws.path("analysis", "notes.md"), `${a.notes.trim()}\n\n`);
      const breakdown = (await ws.readJson<Breakdown>("analysis/breakdown.json"))!;
      if (a.addCuts.length || a.removeCuts.length) {
        const current = await referenceShots(ws);
        const starts = new Set(current.slice(1).map((s) => s.startFrame));
        for (const c of a.removeCuts) starts.delete(c);
        for (const c of a.addCuts) if (c < breakdown.format.frameCount) starts.add(c);
        const bounds = [0, ...[...starts].sort((x, y) => x - y)];
        const fps = breakdown.format.fpsValue;
        const corrected = bounds.map((startFrame, index) => {
          const endFrame = bounds[index + 1] ?? breakdown.format.frameCount;
          const old = current.find((s) => s.startFrame === startFrame);
          return {
            index,
            startFrame,
            endFrame,
            startSec: +(startFrame / fps).toFixed(3),
            endSec: +(endFrame / fps).toFixed(3),
            durationSec: +((endFrame - startFrame) / fps).toFixed(3),
            frames: endFrame - startFrame,
            transitionIn: index === 0 ? ("start" as const) : (old?.transitionIn ?? ("cut" as const)),
            boundaryScore: old?.boundaryScore ?? 1,
          };
        });
        await ws.writeJson("analysis/shots.json", corrected);
      }
      await ws.save();
      const done = Object.keys(ws.project.reviewedPages).length;
      const missing = pages.filter((p) => !ws.project.reviewedPages[String(p.page)]).map((p) => p.page);
      if (!missing.length) await ws.setStage("reviewed");
      const shots = await referenceShots(ws);
      return result(
        [
          `Logged ${done}/${pages.length} pages.${wrong.length ? ` Codes did not match for pages ${wrong.join(", ")}: open them again and read the CHECK code.` : ""}`,
          missing.length ? `Still to read: pages ${missing.join(", ")}.` : "Review complete; planning and generation are unlocked.",
          `Reference shots: ${shots.length}.`,
        ].join("\n"),
        { reviewed: done, total: pages.length, missing, shots: shots.length },
      );
    }),
  );
}
