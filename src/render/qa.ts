import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeReference } from "../engine/analyze.js";
import type { EnergyMap } from "../engine/energy.js";
import { probe } from "../engine/probe.js";
import { round } from "../engine/stats.js";

export interface EnergyRow {
  measure: string;
  reference: number;
  ours: number;
  ratio: number | null;
  status: "pass" | "fail" | "n/a";
  fix?: string;
}

export interface EnergyCheck {
  pass: boolean;
  min: number;
  rows: EnergyRow[];
}

interface Rates {
  cuts: number;
  flashes: number;
  camera: number;
  shake: number;
}

function rates(e: EnergyMap): Rates {
  const d = Math.max(e.durationSec, 1e-6);
  return {
    cuts: e.summary.cutsPerSecond,
    flashes: e.summary.flashesPerSecond,
    camera: e.summary.cameraMoveSeconds / d,
    shake: e.summary.shakeSeconds / d,
  };
}

/** Below these reference levels a measure is not part of the reference's style, so it is not required. */
const FLOORS: Record<keyof Rates, number> = { cuts: 0.5, flashes: 0.15, camera: 0.15, shake: 0.08 };
const FIXES: Record<keyof Rates, string> = {
  cuts: "Cut more often: split long shots and land cuts on beats (b<n> times).",
  flashes: "Add white/black flashes on hits (EDL flashes[] or fx.flashIn/flashOut).",
  camera: "Add camera work: zoom ramps, pans, punch-ins on hits.",
  shake: "Add shake bursts on impacts (camera.shake with from/to around hits).",
};

/** Compares the energy of an output to its reference: each used measure must reach `min` × the reference. */
export function compareEnergy(reference: EnergyMap, ours: EnergyMap, min = 0.6): EnergyCheck {
  const ref = rates(reference);
  const out = rates(ours);
  const rows: EnergyRow[] = (Object.keys(FLOORS) as (keyof Rates)[]).map((k) => {
    const r = ref[k];
    const o = out[k];
    if (r < FLOORS[k]) return { measure: k, reference: round(r), ours: round(o), ratio: null, status: "n/a" };
    const ratio = round(o / r);
    return { measure: k, reference: round(r), ours: round(o), ratio, status: ratio >= min ? "pass" : "fail", fix: ratio >= min ? undefined : FIXES[k] };
  });
  // Too much shake is as wrong as too little.
  if (out.shake > Math.max(1.5 * ref.shake, ref.shake + 0.15)) {
    rows.push({ measure: "shake (max)", reference: round(ref.shake), ours: round(out.shake), ratio: round(out.shake / Math.max(ref.shake, 1e-3)), status: "fail", fix: "Too much shake compared with the reference: shorten or soften shake bursts." });
  }
  return { pass: rows.every((r) => r.status !== "fail"), min, rows };
}

export interface RenderQa {
  frames: number;
  expectedFrames: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  sizeMB: number;
  issues: string[];
  energy?: EnergyCheck;
}

/** Technical checks on a rendered file, plus the energy comparison when a reference energy map exists. */
export async function checkRender(path: string, expect: { frames: number; width: number; height: number; audio: boolean }, reference?: EnergyMap): Promise<RenderQa> {
  const info = await probe(path);
  const v = info.video;
  const issues: string[] = [];
  const frames = v?.frameCount ?? 0;
  if (frames !== expect.frames) issues.push(`Frame count ${frames} ≠ planned ${expect.frames}.`);
  if (v && (v.displayWidth !== expect.width || v.displayHeight !== expect.height)) issues.push(`Size ${v.displayWidth}×${v.displayHeight} ≠ planned ${expect.width}×${expect.height}.`);
  if (expect.audio && !info.audio) issues.push("The soundtrack is missing.");
  let energy: EnergyCheck | undefined;
  if (reference) {
    const dir = await mkdtemp(join(tmpdir(), "ok-qa-"));
    try {
      const ours = await analyzeReference(path, dir, { seed: "qa", skipPages: true });
      energy = compareEnergy(reference, ours.energy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return {
    frames,
    expectedFrames: expect.frames,
    width: v?.displayWidth ?? 0,
    height: v?.displayHeight ?? 0,
    fps: v ? round(v.fps.num / v.fps.den, 3) : 0,
    durationSec: round(info.durationSec),
    hasAudio: Boolean(info.audio),
    sizeMB: round(info.sizeBytes / 2 ** 20, 2),
    issues,
    energy,
  };
}
