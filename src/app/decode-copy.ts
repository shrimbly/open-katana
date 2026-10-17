import type { Breakdown } from "../engine/analyze.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { EnergyMap } from "../engine/energy.js";
import { clockSec, loudnessRise } from "./music.js";

/** A drop is the largest one-second loudness rise of at least this much. */
export const DROP_RISE_DB = 9;

/** Seconds of shake below this aren't worth a mention. */
const MIN_SHAKE_SEC = 0.5;

/** Where the drop lands on the edit's timeline, if the sound has one. */
export function decodeDrop(breakdown: Breakdown, audio?: AudioAnalysis): number | undefined {
  if (!audio) return undefined;
  const rise = loudnessRise(audio.loudnessDb, DROP_RISE_DB);
  return rise ? +(rise.timeSec + breakdown.format.audioOffsetSec).toFixed(3) : undefined;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "a and b"; "a, b, and c" (the serial comma also separates two clauses when one has a comma of its own). */
function list(parts: string[]): string {
  if (parts.length === 2 && !parts[0]!.includes(",")) return parts.join(" and ");
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

const sentence = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}.`;

/**
 * The plain-language read of a decoded edit, one sentence per entry: pace, then how the cuts, flashes
 * and camera sit on the music, then the drop (spec §4.6). Deterministic: thresholds only, no model.
 */
export function decodeRead(a: { breakdown: Breakdown; energy: EnergyMap; audio?: AudioAnalysis }): string[] {
  const { breakdown, energy, audio } = a;
  const s = energy.summary;
  const out: string[] = [];
  const pace = s.cutsPerSecond >= 1.5 ? "Very fast" : s.cutsPerSecond >= 0.8 ? "Fast and punchy" : s.cutsPerSecond >= 0.4 ? "Steady" : "Slow and moody";
  out.push(`${pace}.`);
  if (s.flashesPerSecond > 0.3) out.push("Flash-heavy.");

  const clauses: string[] = [];
  const cuts = breakdown.shots.length - 1;
  if (audio && cuts > 0) {
    // "Mostly on the beat" has no subject of its own, so it stands alone rather than heading a list.
    if (s.cutsOnBeatShare >= 0.7) clauses.push("cuts land on the beat");
    else if (s.cutsOnBeatShare >= 0.4) out.push("Mostly on the beat.");
    else clauses.push("cuts follow the picture, not the beat");
  }
  if (s.flashesPerSecond > 0 && s.flashesPerSecond <= 0.3) clauses.push(audio ? "flashes hit the drops" : "flashes mark the big moments");
  const punches = energy.events.filter((e) => e.type === "punch").length;
  const shake = s.shakeSeconds >= MIN_SHAKE_SEC ? `${+s.shakeSeconds.toFixed(1)} s of shake` : undefined;
  if (punches) clauses.push(`the camera punches in ${times(punches)}${shake ? `, with ${shake}` : ""}`);
  else if (shake) clauses.push(`there's ${shake}`);
  if (clauses.length) out.push(sentence(list(clauses)));

  const drop = decodeDrop(breakdown, audio);
  if (drop !== undefined) out.push(`The drop lands at ${clockSec(drop)}.`);
  return out;
}
