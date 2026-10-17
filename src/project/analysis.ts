import { createHash } from "node:crypto";
import { type AnalyzePhaseEvent, type Breakdown, analyzeReference } from "../engine/analyze.js";
import type { SheetPage } from "../engine/sheets.js";
import type { Workspace } from "./workspace.js";

export type { AnalyzePhaseEvent } from "../engine/analyze.js";

/** A review page as stored in analysis/pages.json: the check code only as a hash, so it can only be read off the image. */
export interface StoredPage {
  page: number;
  startFrame: number;
  endFrame: number;
  path: string;
  codeHash: string;
}

export const hashCode = (project: string, code: string) => createHash("sha256").update(`${project}:${code.toUpperCase()}`).digest("hex");

/**
 * Analyses the project's reference once: the body of katana_analyze, shared with the app's decode, so
 * the director never analyses again and the review gate is the same either way. Pages are stored with
 * hashed codes seeded by the project id; a fresh analysis resets the review and sets the stage.
 */
export async function analyzeProject(ws: Workspace, opts: { force?: boolean; onPhase?: (e: AnalyzePhaseEvent) => void } = {}): Promise<{ reused: boolean; pages: number }> {
  const ref = ws.reference();
  if (!ref) throw new Error("This project has no reference video. Import one with katana_import (role reference) or plan from the preset recipe.");
  const breakdown = await ws.readJson<Breakdown>("analysis/breakdown.json");
  const stored = await ws.readJson<StoredPage[]>("analysis/pages.json");
  if (!opts.force && breakdown && stored) return { reused: true, pages: stored.length };
  const r = await analyzeReference(ws.path(ref.path), ws.path("analysis"), { seed: ws.project.id, onPhase: opts.onPhase });
  const pages = r.pages.map(({ code, ...p }: SheetPage) => ({ ...p, codeHash: hashCode(ws.project.id, code) }));
  await ws.writeJson("analysis/pages.json", pages);
  ws.project.reviewedPages = {};
  await ws.save();
  await ws.setStage("analyzed");
  return { reused: false, pages: pages.length };
}
