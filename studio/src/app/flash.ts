import { useEffect, useState } from "preact/hooks";

/**
 * Motion that means something (spec §5.4, D35): the arrival flash for DECODED IN n S and READY., and
 * tile edges synced to an example's own flash frames. Nothing here loops, and all of it is off when the
 * person prefers reduced motion.
 */

const reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

export const reducedMotion = (): boolean => Boolean(reduceQuery?.matches);

/** Re-renders when the reduced-motion preference changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    if (!reduceQuery) return;
    const update = () => setReduced(reduceQuery.matches);
    reduceQuery.addEventListener("change", update);
    return () => reduceQuery.removeEventListener("change", update);
  }, []);
  return reduced;
}

const arrived = new Set<string>();
let lastFlashAt = -Infinity;

/**
 * One full-viewport flash (`--flash` at 0.6 opacity → 0 over 140 ms). `key` names the arrival
 * (e.g. `ready:<run>:<version>`) so it fires once per arrival, however often the screen renders;
 * never more than one per second.
 */
export function arrivalFlash(key: string): void {
  if (arrived.has(key)) return;
  arrived.add(key);
  const now = performance.now();
  if (reducedMotion() || now - lastFlashAt < 1000) return;
  lastFlashAt = now;
  const el = document.createElement("div");
  el.className = "kt-arrival";
  el.setAttribute("aria-hidden", "true");
  document.body.append(el);
  const remove = () => el.remove();
  el.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 600);
}

/** The example's flash times thinned so two edge flashes are at least `minGap` s apart (≤ 3 per second, WCAG 2.3.1). */
export function edgeFlashTimes(flashes: { t: number }[], minGap = 1 / 3): number[] {
  const out: number[] = [];
  for (const t of flashes.map((f) => f.t).sort((a, b) => a - b)) {
    if (out.length === 0 || t - out[out.length - 1]! >= minGap) out.push(t);
  }
  return out;
}

/** True when playback moved past one of `times` between `prev` and `now` (a loop back to the start counts from 0). */
export function crossedAny(times: number[], prev: number, now: number): boolean {
  if (now < prev) return times.some((t) => t <= now);
  return times.some((t) => t > prev && t <= now);
}
