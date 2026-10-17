import { type RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * Time on screen: timecodes in the app's voice ("0:08.2"), and a media clock that follows a playing
 * video frame by frame so the Cut Map's playhead and beat dots stay locked to the picture.
 */

/** "0:08.2" (tenths) or "1:02" (`digits` 0). */
export function fmtTime(sec: number, digits = 1): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const fixed = rest.toFixed(digits);
  // 59.96 rounds to "60.0": carry into the minutes.
  if (Number(fixed) >= 60) return fmtTime((m + 1) * 60, digits);
  const [whole, frac] = fixed.split(".");
  return `${m}:${whole!.padStart(2, "0")}${frac ? `.${frac}` : ""}`;
}

/** "16.4 s" (one decimal unless whole) or, with `round`, "16 s". */
export function fmtSeconds(sec: number, round = false): string {
  if (round) return `${Math.round(sec)} s`;
  const r = Math.round(sec * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} s`;
}

/** "31–42" with an en dash; equal ends collapse to one number. */
export function fmtRange(low: number, high: number, digits = 0): string {
  const a = low.toFixed(digits);
  const b = high.toFixed(digits);
  return a === b ? a : `${a}–${b}`;
}

/** "$3–8" or "$1.70". */
export function fmtUsd(low: number, high?: number): string {
  const one = (v: number) => (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2));
  if (high === undefined || Math.abs(high - low) < 0.005) return `$${one(low)}`;
  return `$${one(low)}–${one(high)}`;
}

/**
 * The media element's current time, updated every animation frame while it plays and on seeks while
 * paused. `undefined` until the element has metadata.
 */
export function useMediaTime(ref: RefObject<HTMLMediaElement>, active = true): number | undefined {
  const [time, setTime] = useState<number>();
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let frame = 0;
    const read = () => setTime(el.readyState > 0 ? el.currentTime : undefined);
    const tick = () => {
      read();
      if (!el.paused && !el.ended) frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const events = ["seeked", "timeupdate", "loadedmetadata", "pause", "emptied"] as const;
    for (const e of events) el.addEventListener(e, read);
    el.addEventListener("play", onPlay);
    read();
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      for (const e of events) el.removeEventListener(e, read);
      el.removeEventListener("play", onPlay);
    };
  }, [ref, active]);
  return time;
}

/** Index of the item whose [start, end) holds `t`, else the last one starting before it (-1 if none). */
export function indexAt<T extends { start: number; end: number }>(items: T[], t: number): number {
  let found = -1;
  for (const [i, it] of items.entries()) {
    if (it.start <= t + 1e-6) found = i;
    if (t < it.end) break;
  }
  return found;
}
