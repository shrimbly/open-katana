import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetPath, dataHome } from "../util/paths.js";

/**
 * Curated SIL OFL families from github.com/google/fonts, fetched on first use.
 * libass renders variable fonts at their default instance, so heavy looks use static faces.
 */
export const FONTS: Record<string, { path: string; style: string }> = {
  Anton: { path: "ofl/anton/Anton-Regular.ttf", style: "heavy condensed sans; the classic aura/edit title face" },
  "Bebas Neue": { path: "ofl/bebasneue/BebasNeue-Regular.ttf", style: "tall condensed caps; captions and stacked titles" },
  "League Gothic": { path: "ofl/leaguegothic/LeagueGothic%5Bwdth%5D.ttf", style: "narrow condensed gothic" },
  Oswald: { path: "ofl/oswald/Oswald%5Bwght%5D.ttf", style: "condensed sans, regular weight" },
  "Archivo Black": { path: "ofl/archivoblack/ArchivoBlack-Regular.ttf", style: "wide heavy grotesk; slams and impact words" },
  Teko: { path: "ofl/teko/Teko%5Bwght%5D.ttf", style: "squared condensed; sport and tech HUDs" },
  "Black Ops One": { path: "ofl/blackopsone/BlackOpsOne-Regular.ttf", style: "stencil military; gritty edits" },
  UnifrakturMaguntia: { path: "ofl/unifrakturmaguntia/UnifrakturMaguntia-Book.ttf", style: "blackletter; moody night edits and gothic titles" },
  Cinzel: { path: "ofl/cinzel/Cinzel%5Bwght%5D.ttf", style: "roman inscription caps; cinematic and epic" },
  "Playfair Display": { path: "ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf", style: "high-contrast serif; luxury and fashion" },
  "Cormorant Garamond": { path: "ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf", style: "delicate serif; quotes and subtitles" },
  Inter: { path: "ofl/inter/Inter%5Bopsz,wght%5D.ttf", style: "neutral sans; small captions" },
  Montserrat: { path: "ofl/montserrat/Montserrat%5Bwght%5D.ttf", style: "geometric sans; clean captions" },
  "Space Grotesk": { path: "ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf", style: "techy grotesk; HUD labels" },
  Monoton: { path: "ofl/monoton/Monoton-Regular.ttf", style: "neon multi-line display" },
  "JetBrains Mono": { path: "ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", style: "monospace; timecodes, data and typewriter text" },
  Archivo: { path: "ofl/archivo/Archivo%5Bwdth,wght%5D.ttf", style: "grotesk with a width axis; clean editorial captions" },
};

export const fontsDir = () => join(dataHome(), "fonts");

/** File name a family is stored under in the fonts directory. */
export function fontFileName(family: string): string {
  const font = FONTS[family];
  if (!font) throw new Error(`Unknown font "${family}"`);
  return decodeURIComponent(font.path.split("/").pop()!).replace(/[[\]]/g, "_");
}

export interface FontMetrics {
  unitsPerEm: number;
  /** OS/2 win ascent/descent: libass sizes a font so their sum equals the requested font size. */
  winAscent: number;
  winDescent: number;
  capHeight: number;
}

/** Reads the vertical metrics libass uses from a TrueType/OpenType file. */
export function readFontMetrics(file: string): FontMetrics {
  const b = readFileSync(file);
  const tables = new Map<string, number>();
  const count = b.readUInt16BE(4);
  for (let i = 0; i < count; i++) tables.set(b.toString("latin1", 12 + 16 * i, 16 + 16 * i), b.readUInt32BE(20 + 16 * i));
  const head = tables.get("head");
  const os2 = tables.get("OS/2");
  const hhea = tables.get("hhea");
  if (head === undefined || hhea === undefined) throw new Error(`${file} is not a TrueType font`);
  const unitsPerEm = b.readUInt16BE(head + 18);
  let winAscent = os2 !== undefined ? b.readUInt16BE(os2 + 74) : 0;
  let winDescent = os2 !== undefined ? b.readUInt16BE(os2 + 76) : 0;
  if (winAscent + winDescent === 0) {
    winAscent = b.readInt16BE(hhea + 4);
    winDescent = -b.readInt16BE(hhea + 6);
  }
  const version = os2 !== undefined ? b.readUInt16BE(os2) : 0;
  const capHeight = os2 !== undefined && version >= 2 ? b.readInt16BE(os2 + 88) : 0;
  return { unitsPerEm, winAscent, winDescent, capHeight: capHeight > 0 ? capHeight : Math.round(unitsPerEm * 0.7) };
}

const metricsCache = new Map<string, FontMetrics>();

/** Metrics for a downloaded family (call ensureFonts first). */
export function fontMetrics(family: string): FontMetrics | undefined {
  const hit = metricsCache.get(family);
  if (hit) return hit;
  const file = family === "JetBrains Mono" && !existsSync(join(fontsDir(), fontFileName(family))) ? join(fontsDir(), "JetBrainsMono-bundled.ttf") : join(fontsDir(), fontFileName(family));
  if (!existsSync(file)) return undefined;
  const m = readFontMetrics(file);
  metricsCache.set(family, m);
  return m;
}

/** Cap height as a share of the libass font size (ascent + descent), so text sizes mean cap height. */
export function capRatio(family: string): number {
  const m = fontMetrics(family);
  return m ? m.capHeight / (m.winAscent + m.winDescent) : 0.7;
}

/** File name of a static weight/italic instance in the fonts directory. */
export function faceFileName(family: string, weight = 400, italic = false): string {
  return `Face-${family.replace(/[^A-Za-z0-9]/g, "")}-${weight}${italic ? "i" : ""}.ttf`;
}

/**
 * Fetches a static instance (a real bold, light or italic face) from the Google Fonts CSS API into
 * the fonts directory, so libass picks it by weight and slant instead of faking it. Returns false
 * when the family has no such face (libass then synthesises it).
 */
export async function ensureFace(family: string, weight = 400, italic = false): Promise<boolean> {
  if (weight === 400 && !italic) return true;
  const dir = fontsDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, faceFileName(family, weight, italic));
  if (existsSync(file)) return true;
  if (existsSync(`${file}.missing`)) return false;
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:ital,wght@${italic ? 1 : 0},${weight}`).catch(() => undefined);
  const url = css?.ok ? /src:\s*url\(([^)]+\.ttf)\)/.exec(await css.text())?.[1] : undefined;
  if (!url) {
    // Remember a face the family doesn't have, but not a network failure.
    if (css && !css.ok) await writeFile(`${file}.missing`, "");
    return false;
  }
  const res = await fetch(url);
  if (!res.ok) return false;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return true;
}

/** Ensures every weight/italic face used by these text events is present. */
export async function ensureFaces(faces: { font: string; weight?: number; italic?: boolean }[]): Promise<void> {
  const seen = new Set<string>();
  for (const f of faces) {
    const key = `${f.font}|${f.weight ?? 400}|${Boolean(f.italic)}`;
    if (seen.has(key) || !FONTS[f.font]) continue;
    seen.add(key);
    await ensureFace(f.font, f.weight ?? 400, Boolean(f.italic)).catch(() => false);
  }
}

/** Ensures the families are downloaded into the shared fonts directory and returns that directory. */
export async function ensureFonts(families: string[]): Promise<string> {
  const dir = fontsDir();
  await mkdir(dir, { recursive: true });
  const bundled = assetPath("fonts", "JetBrainsMono.ttf");
  const bundledCopy = join(dir, "JetBrainsMono-bundled.ttf");
  if (!existsSync(bundledCopy) && existsSync(bundled)) {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(bundled, bundledCopy);
  }
  for (const family of new Set(families)) {
    const font = FONTS[family];
    if (!font) {
      throw new Error(`Unknown font "${family}". Available: ${Object.keys(FONTS).join(", ")}`);
    }
    const file = join(dir, fontFileName(family));
    if (existsSync(file)) continue;
    const res = await fetch(`https://github.com/google/fonts/raw/main/${font.path}`, { redirect: "follow" });
    if (!res.ok) throw new Error(`Could not download font ${family} (${res.status})`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return dir;
}
