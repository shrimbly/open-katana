import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../project/workspace.js";
import { HistoryFileSchema } from "../schemas.js";
import { appDir } from "../http.js";
import type { HistoryFile, HistorySample, PhaseId } from "../types.js";

/**
 * What finished edits cost and took (~/.open-katana/app/history.json, ≤ 30 samples per kind). Once a
 * kind has three samples, estimates and ETAs use them instead of the seeds.
 */

export type HistoryKind = HistorySample["kind"];
const PER_KIND = 30;
export const MIN_SAMPLES = 3;

const historyFile = () => join(appDir(), "history.json");

export async function loadHistory(): Promise<HistoryFile> {
  const file = historyFile();
  if (!existsSync(file)) return { v: 1, samples: [] };
  try {
    const parsed = HistoryFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : { v: 1, samples: [] };
  } catch {
    return { v: 1, samples: [] };
  }
}

export async function appendSample(sample: HistorySample): Promise<void> {
  const h = await loadHistory();
  const same = h.samples.filter((s) => s.kind === sample.kind);
  const others = h.samples.filter((s) => s.kind !== sample.kind);
  const kept = [...same, sample].slice(-PER_KIND);
  await writeFileAtomic(historyFile(), `${JSON.stringify({ v: 1, samples: [...others, ...kept] }, null, 2)}\n`);
}

/** The q-quantile (0..1) of sorted values, interpolated. */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const ofKind = (h: HistoryFile, kind: HistoryKind) => h.samples.filter((s) => s.kind === kind);

/** Claude cost p25–p90 of the kind, when there are enough samples. */
export function costRange(h: HistoryFile, kind: HistoryKind): [number, number] | undefined {
  const xs = ofKind(h, kind).map((s) => s.costUsd);
  return xs.length >= MIN_SAMPLES ? [quantile(xs, 0.25), quantile(xs, 0.9)] : undefined;
}

/** Wall-clock minutes around the median (±30%), when there are enough samples. */
export function wallRange(h: HistoryFile, kind: HistoryKind): [number, number] | undefined {
  const xs = ofKind(h, kind).map((s) => s.wallMin);
  if (xs.length < MIN_SAMPLES) return undefined;
  const m = quantile(xs, 0.5);
  return [m * 0.7, m * 1.3];
}

/** Median minutes per phase over the kind's samples (phases seen in at least three of them). */
export function phaseMedians(h: HistoryFile, kind: HistoryKind): Partial<Record<PhaseId, number>> {
  const out: Partial<Record<PhaseId, number>> = {};
  const samples = ofKind(h, kind);
  const phases = new Set(samples.flatMap((s) => Object.keys(s.phaseSec) as PhaseId[]));
  for (const p of phases) {
    const xs = samples.map((s) => s.phaseSec[p]).filter((v): v is number => typeof v === "number");
    if (xs.length >= MIN_SAMPLES) out[p] = quantile(xs, 0.5) / 60;
  }
  return out;
}
