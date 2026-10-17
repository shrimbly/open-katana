import type { JSX, RefObject } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { TitleStyle } from "../../../src/app/types.js";

/**
 * Each template's title is set in its own edit font (spec §5.2). Faces come from the server's
 * `/api/fonts/face` (the files the renderer uses) and swap in when loaded; until then the title shows
 * in Archivo 900 at width 62%, so nothing jumps more than the face itself.
 */

type Face = { font: string; weight: number; italic: boolean };

const faces = new Map<string, Promise<boolean>>();
const loadedKeys = new Set<string>();

const keyOf = (f: Face) => `${f.font}|${f.weight}|${f.italic ? 1 : 0}`;

async function fetchFace(font: string, weight: number, italic: boolean): Promise<{ url: string; italic: boolean } | undefined> {
  const res = await fetch(`/api/fonts/face?family=${encodeURIComponent(font)}&weight=${weight}&italic=${italic ? 1 : 0}`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { url?: string; italic?: boolean };
  return body.url ? { url: body.url, italic: body.italic ?? italic } : undefined;
}

/**
 * Loads one face into the page. A family without a real italic (League Gothic) gets its upright file
 * from the server, registered as upright so the browser slants it, as the renderer does.
 */
export function loadDisplayFace(f: Face): Promise<boolean> {
  const key = keyOf(f);
  let p = faces.get(key);
  if (!p) {
    p = (async () => {
      const got = await fetchFace(f.font, f.weight, f.italic);
      if (!got) return false;
      const { url } = got;
      const style = got.italic ? "italic" : "normal";
      const face = new FontFace(f.font, `url("${url}")`, { weight: String(f.weight), style, display: "swap" });
      await face.load();
      document.fonts.add(face);
      loadedKeys.add(key);
      return true;
    })().catch(() => false);
    faces.set(key, p);
  }
  return p;
}

const caseTransform = (c: TitleStyle["case"] | undefined): JSX.CSSProperties["textTransform"] => (c === "upper" ? "uppercase" : c === "lower" ? "lowercase" : "none");

/** Applies a template's case rule to a string (for places that can't use CSS, like the canvas). */
export function applyCase(text: string, c: TitleStyle["case"] | undefined): string {
  return c === "upper" ? text.toUpperCase() : c === "lower" ? text.toLowerCase() : text;
}

/** Archivo 900 at width 62%: the stand-in while a template's face loads, and when it can't. */
export const DISPLAY_FALLBACK: JSX.CSSProperties = { fontFamily: "Archivo, var(--ui)", fontWeight: 900, fontStretch: "62%", fontStyle: "normal" };

/**
 * CSS for text set in a face (no colour). Re-renders once the face has loaded. Pass `undefined` for
 * the app's own type.
 */
export function useFaceStyle(face: Face | undefined, textCase?: TitleStyle["case"]): JSX.CSSProperties {
  const key = face ? keyOf(face) : "";
  const [loaded, setLoaded] = useState(() => loadedKeys.has(key));
  useEffect(() => {
    if (!face) return;
    if (loadedKeys.has(key)) return setLoaded(true);
    setLoaded(false);
    let live = true;
    void loadDisplayFace(face).then((ok) => live && setLoaded(ok));
    return () => {
      live = false;
    };
    // `key` covers the face's fields.
  }, [key]);
  const transform = { textTransform: caseTransform(textCase) };
  if (!face) return transform;
  if (!loaded) return { ...DISPLAY_FALLBACK, ...transform };
  return { fontFamily: `"${face.font}", Archivo, var(--ui)`, fontWeight: face.weight, fontStyle: face.italic ? "italic" : "normal", fontStretch: "100%", ...transform };
}

/** A template title's full style: its face, case and accent colour. */
export function useTitleStyle(style: TitleStyle | undefined): JSX.CSSProperties {
  const face = style ? { font: style.font, weight: style.weight, italic: style.italic } : undefined;
  const css = useFaceStyle(face, style?.case);
  return style ? { ...css, color: style.color } : css;
}

/**
 * Sizes a title to its box: the largest font size (up to `maxPx`) at which the longest word fits the
 * width and the whole title fits `maxLines` lines. Re-fits on resize and when fonts load.
 */
export function useFitText(ref: RefObject<HTMLElement>, opts: { maxPx: number; minPx?: number; maxLines?: number; maxHeight?: number; deps?: unknown[] }): void {
  const { maxPx, minPx = 12, maxLines = 3, maxHeight } = opts;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const box = el.parentElement ?? el;
      const width = el.clientWidth || box.clientWidth;
      if (!width) return;
      let size = maxPx;
      el.style.fontSize = `${size}px`;
      // Two passes: proportional shrink for width, then for height (line count).
      for (let i = 0; i < 4; i++) {
        const over = el.scrollWidth / width;
        const lineH = parseFloat(getComputedStyle(el).lineHeight) || size;
        const lines = el.scrollHeight / lineH;
        // `maxHeight` is a share of the parent's height the title may take.
        const tall = maxHeight ? el.scrollHeight / (box.clientHeight * maxHeight) : 0;
        const shrink = Math.max(over, lines > maxLines + 0.2 ? Math.sqrt(lines / maxLines) : 1, tall > 1 ? tall : 1);
        if (shrink <= 1.001) break;
        size = Math.max(minPx, Math.floor(size / shrink));
        el.style.fontSize = `${size}px`;
        if (size === minPx) break;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      ro.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [ref, maxPx, minPx, maxLines, maxHeight, ...(opts.deps ?? [])]);
}
