import { api, type FontInfo } from "./api.js";
import { forgetMetrics, setFontMetrics } from "./textdraw.js";

let catalog: Promise<Record<string, FontInfo>> | undefined;
const loaded = new Map<string, Promise<void>>();

export function fontCatalog(): Promise<Record<string, FontInfo>> {
  catalog ??= api.fonts().then(
    (c) => {
      for (const [family, info] of Object.entries(c)) if (info.metrics) setFontMetrics(family, info.metrics);
      return c;
    },
    () => ({}),
  );
  return catalog;
}

/** Loads a curated font family (the same files the renderer uses) into the page. */
export function loadFont(family: string): Promise<void> {
  let p = loaded.get(family);
  if (!p) {
    p = (async () => {
      const info = (await fontCatalog())[family];
      if (!info) return;
      const face = new FontFace(family, `url("${info.url}")`);
      await face.load();
      document.fonts.add(face);
      forgetMetrics();
    })().catch(() => undefined);
    loaded.set(family, p);
  }
  return p;
}

/** Loads a static weight/italic face of a family (the renderer uses the same file). */
export function loadFace(family: string, weight = 400, italic = false): Promise<void> {
  if (weight === 400 && !italic) return loadFont(family);
  const key = `${family}|${weight}|${italic}`;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      await loadFont(family);
      const res = await fetch(`/api/fonts/face?family=${encodeURIComponent(family)}&weight=${weight}&italic=${italic ? 1 : 0}`);
      if (!res.ok) return;
      const { url } = (await res.json()) as { url: string };
      const face = new FontFace(family, `url("${url}")`, { weight: String(weight), style: italic ? "italic" : "normal" });
      await face.load();
      document.fonts.add(face);
      forgetMetrics();
    })().catch(() => undefined);
    loaded.set(key, p);
  }
  return p;
}

export const loadFonts = (families: Iterable<string>) => Promise.all([...new Set(families)].map(loadFont));

/** Loads every face (family, weight, slant) a set of text layers uses. */
export const loadTextFaces = (texts: { font: string; weight?: number; italic?: boolean }[]) =>
  Promise.all(texts.map((t) => loadFace(t.font, t.weight ?? 400, Boolean(t.italic))));
