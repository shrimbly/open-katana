import { rename } from "node:fs/promises";
import { type AudioAnalysis, analyzeAudio } from "../engine/audio.js";
import { type Edl, EdlSchema, gridBeats } from "../render/edl.js";
import { type RenderResult, renderEdl } from "../render/render.js";
import type { Workspace } from "./workspace.js";

/** Beats on the edit timeline: the EDL's grid override, or the soundtrack's tracked beats shifted by its start offset. */
export async function edlBeats(ws: Workspace, edl: Edl): Promise<number[]> {
  if (edl.grid) return gridBeats(edl.grid, edl.canvas.durationSec ?? 300);
  if (!edl.audio) return (await ws.readJson<AudioAnalysis>("analysis/audio.json"))?.beats ?? [];
  const { asset, offset } = edl.audio;
  let beats: number[] | undefined;
  if (asset === "ref" || ws.asset(asset).role === "reference") {
    beats = (await ws.readJson<AudioAnalysis>("analysis/audio.json"))?.beats;
  }
  if (!beats) {
    const cache = `analysis/audio-${asset}.json`;
    let audio = await ws.readJson<AudioAnalysis>(cache);
    if (!audio) {
      audio = await analyzeAudio(ws.assetPath(asset));
      await ws.writeJson(cache, audio);
    }
    beats = audio.beats;
  }
  return beats.map((b) => +(b - offset).toFixed(4)).filter((b) => b >= 0);
}

export type RenderMode = "preview" | "master" | "notext";

/**
 * Renders the project's saved EDL. "notext" is a half-resolution render without overlay text (text
 * behind the subject stays, since it is part of the picture), used by the studio to draw text live
 * on top while it is being edited. The file is replaced atomically so open players never read a
 * half-written render.
 */
/** The canvas scaled so its long side is `longSide` (even sides, as the encoder needs). */
export function masterSize(canvas: { width: number; height: number }, longSide: number): { width: number; height: number } {
  const k = longSide / Math.max(canvas.width, canvas.height);
  return { width: Math.round((canvas.width * k) / 2) * 2, height: Math.round((canvas.height * k) / 2) * 2 };
}

export async function renderProject(ws: Workspace, mode: RenderMode, edlOverride?: Edl, onProgress?: (done: number, total: number) => void): Promise<RenderResult> {
  const saved = edlOverride ?? (await ws.readJson("render/edl.json", EdlSchema));
  if (!saved) throw new Error("No edit saved yet.");
  // Overlay text and the flashes that wash over it are drawn live by the studio.
  const edl = mode === "notext" ? { ...saved, text: saved.text.filter((t) => t.behind), flashes: saved.flashes.filter((f) => !f.overText) } : saved;
  const final = ws.path("render", `${mode === "notext" ? "preview-notext" : mode}.mp4`);
  const master = mode === "master" ? edl.canvas.master : undefined;
  const sized = master ? { ...edl, canvas: { ...edl.canvas, ...masterSize(edl.canvas, master.longSide) } } : edl;
  const result = await renderEdl(sized, {
    source: (id) => {
      // The master uses each generated shot's upscaled copy when there is one.
      const a = (mode === "master" && ws.upscaled(id)) || ws.asset(id);
      return { path: ws.path(a.path), kind: a.kind, hasAudio: a.hasAudio ?? a.kind === "audio" };
    },
    beats: await edlBeats(ws, saved),
    outPath: `${final}.partial.mp4`,
    cacheDir: ws.path("render", "cache"),
    preview: mode !== "master",
    onProgress,
  });
  await rename(result.path, final);
  return { ...result, path: final };
}
