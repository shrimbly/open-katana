/** Edit times are seconds, "b<n>" beats of the soundtrack or "f<n>" frames — the same rules as the renderer. */
export type Time = number | string;

export function toSec(t: Time, fps: number, beats: number[]): number {
  if (typeof t === "number") return t;
  const n = Number(t.slice(1));
  if (t[0] === "f") return n / fps;
  if (!beats.length) return 0;
  const i = Math.floor(n);
  const at = (k: number) => {
    if (k < beats.length) return beats[k]!;
    const period = beats.length > 1 ? (beats.at(-1)! - beats[0]!) / (beats.length - 1) : 0.5;
    return beats.at(-1)! + (k - beats.length + 1) * period;
  };
  return at(i) + (n - i) * (at(i + 1) - at(i));
}

export type Snap = "beats" | "frames" | "off";

/** Snaps a time and returns both seconds and the value to store (beats stay musical). */
export function snapTime(sec: number, snap: Snap, fps: number, beats: number[]): { sec: number; value: Time } {
  const frame = Math.max(0, Math.round(sec * fps));
  if (snap === "beats" && beats.length) {
    let best = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i]! - sec) < Math.abs(beats[best]! - sec)) best = i;
    // Half-beat snapping keeps fast edits on the grid without forcing whole beats.
    const half = best + (sec > beats[best]! ? 0.5 : -0.5);
    const candidates = [best, half].filter((b) => b >= 0);
    const pick = candidates.reduce((a, b) => (Math.abs(toSec(`b${b}`, fps, beats) - sec) < Math.abs(toSec(`b${a}`, fps, beats) - sec) ? b : a));
    const s = toSec(`b${pick}`, fps, beats);
    if (Math.abs(s - sec) < 0.12) return { sec: s, value: `b${pick}` };
  }
  if (snap === "off") return { sec, value: +sec.toFixed(3) };
  return { sec: frame / fps, value: +(frame / fps).toFixed(4) };
}

/** HH:MM:SS:FF timecode. */
export function timecode(sec: number, fps: number): string {
  const total = Math.max(0, Math.round(sec * fps));
  const f = total % Math.round(fps);
  const s = Math.floor(total / Math.round(fps));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

/** Beats of a fixed grid (mirrors gridBeats in the renderer). */
export function gridBeats(grid: { bpm: number; phase: number }, durationSec: number): number[] {
  const period = 60 / grid.bpm;
  const out: number[] = [];
  for (let t = grid.phase; t <= durationSec + 4 * period; t += period) out.push(+t.toFixed(4));
  return out;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
