import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assetPath } from "../util/paths.js";
import { run } from "../util/proc.js";

const PAGE_WIDTH = 1536;
const TARGET_PAGE_ASPECT = 1.5;

export interface SheetPage {
  page: number;
  startFrame: number;
  /** One past the last frame on the page. */
  endFrame: number;
  path: string;
  /** Short code drawn on the page; reporting it proves the page was actually viewed. */
  code: string;
}

export interface GridChoice {
  cols: number;
  rows: number;
  thumbWidth: number;
  thumbHeight: number;
}

/** Picks a grid for `count` thumbnails of the given aspect (width/height) so the page is roughly 3:2. */
export function chooseGrid(count: number, aspect: number): GridChoice {
  let best: GridChoice | undefined;
  let bestErr = Infinity;
  for (let cols = 2; cols <= 10; cols++) {
    const rows = Math.ceil(count / cols);
    const thumbWidth = Math.floor(PAGE_WIDTH / cols / 2) * 2;
    const thumbHeight = Math.max(2, Math.round(thumbWidth / aspect / 2) * 2);
    const pageAspect = (cols * thumbWidth) / (rows * thumbHeight);
    const waste = cols * rows - count;
    const err = Math.abs(Math.log(pageAspect / TARGET_PAGE_ASPECT)) + waste * 0.02;
    if (err < bestErr) {
      bestErr = err;
      best = { cols, rows, thumbWidth, thumbHeight };
    }
  }
  return best!;
}

export function pageCode(seed: string, page: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const digest = createHash("sha256").update(`${seed}:${page}`).digest();
  return Array.from(digest.subarray(0, 4), (b) => alphabet[b % alphabet.length]).join("");
}

function fontFile(): string {
  return assetPath("fonts", "JetBrainsMono.ttf").replace(/\\/g, "/").replace(/:/g, "\\:");
}

export interface LabelOptions {
  /** Presentation time of the first frame; stamped times are relative to it. */
  t0?: number;
  /** First frame of every shot after the first; adds an "S<n>" shot index to each label. */
  shotStarts?: number[];
}

/**
 * drawtext filter stamping the source frame number, relative time (and shot index) on every frame.
 * It must run before any `select` so `n` is the source frame number.
 */
function label(thumbHeight: number, opts: LabelOptions = {}): string {
  const size = Math.max(10, Math.round(thumbHeight * 0.11));
  const t0 = (opts.t0 ?? 0).toFixed(6);
  const rel = `(t-${t0})`;
  const secs = `%{eif\\:trunc(${rel}+0.0005)\\:d}.%{eif\\:mod(trunc(${rel}*1000+0.5)\\,1000)\\:d\\:3}s`;
  const shot = opts.shotStarts
    ? `S%{eif\\:${opts.shotStarts.length ? opts.shotStarts.map((b) => `gte(n\\,${b})`).join("+") : "0"}\\:d} `
    : "";
  const text = `${shot}#%{eif\\:n\\:d}  ${secs}`;
  return `drawtext=fontfile='${fontFile()}':text='${text}':x=4:y=4:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=3`;
}

const fit = (g: GridChoice) => [
  `scale=${g.thumbWidth}:${g.thumbHeight}:force_original_aspect_ratio=decrease`,
  `pad=${g.thumbWidth}:${g.thumbHeight}:(ow-iw)/2:(oh-ih)/2`,
];

/**
 * Renders every native frame in [startFrame, endFrame) onto pages of `framesPerPage` thumbnails,
 * each stamped with its frame number and time.
 */
export async function everyFramePages(opts: {
  input: string;
  outDir: string;
  aspect: number;
  framesPerPage: number;
  startFrame?: number;
  endFrame: number;
  seed: string;
  prefix?: string;
  label?: LabelOptions;
}): Promise<SheetPage[]> {
  const start = opts.startFrame ?? 0;
  const prefix = opts.prefix ?? "page";
  const grid = chooseGrid(opts.framesPerPage, opts.aspect);
  await mkdir(opts.outDir, { recursive: true });
  // tile drops an incomplete final page, so pad the selection with blank frames to fill it.
  const perPage = opts.framesPerPage;
  const total = opts.endFrame - start;
  const fill = (perPage - (total % perPage)) % perPage;
  const pagesNeeded = Math.ceil(total / perPage);
  const filter = [
    ...fit(grid),
    label(grid.thumbHeight, opts.label),
    `select='between(n\\,${start}\\,${opts.endFrame - 1})'`,
    `tpad=stop=${fill}:color=0x111111`,
    `tile=${grid.cols}x${grid.rows}:nb_frames=${perPage}:padding=2:margin=2:color=0x111111`,
  ].join(",");
  const pattern = join(opts.outDir, `${prefix}-%03d.jpg`);
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", opts.input, "-fps_mode", "passthrough", "-vf", filter,
    "-frames:v", String(pagesNeeded), "-q:v", "4", pattern,
  ]);

  const files = (await readdir(opts.outDir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".jpg")).sort();
  const pages: SheetPage[] = [];
  for (const [i, file] of files.entries()) {
    const page = i + 1;
    const code = pageCode(opts.seed, page);
    const path = join(opts.outDir, file);
    await run("ffmpeg", [
      "-v", "error", "-y", "-i", path,
      "-vf", `drawtext=fontfile='${fontFile()}':text='CHECK ${code}':x=w-tw-8:y=h-th-8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.8:boxborderw=4`,
      "-q:v", "4", path,
    ]);
    const pageStart = start + i * opts.framesPerPage;
    pages.push({ page, startFrame: pageStart, endFrame: Math.min(opts.endFrame, pageStart + opts.framesPerPage), path, code });
  }
  return pages;
}

/** One sheet with the given frames (e.g. the middle frame of every shot), each labelled. */
export async function frameSheet(opts: {
  input: string;
  outPath: string;
  aspect: number;
  frames: number[];
  maxThumbs?: number;
  label?: LabelOptions;
}): Promise<string> {
  const frames = opts.frames.slice(0, opts.maxThumbs ?? 60);
  const grid = chooseGrid(frames.length, opts.aspect);
  const select = frames.map((f) => `eq(n\\,${f})`).join("+");
  const filter = [
    ...fit(grid),
    label(grid.thumbHeight, opts.label),
    `select='${select}'`,
    `tile=${grid.cols}x${grid.rows}:padding=2:margin=2:color=0x111111`,
  ].join(",");
  await run("ffmpeg", ["-v", "error", "-y", "-i", opts.input, "-fps_mode", "passthrough", "-vf", filter, "-frames:v", "1", "-q:v", "4", opts.outPath]);
  return opts.outPath;
}

/** Samples a clip every `everySec` seconds onto one sheet (used to review generated clips). */
export async function sampleSheet(opts: {
  input: string;
  outPath: string;
  aspect: number;
  fps: number;
  durationSec: number;
  everySec?: number;
}): Promise<string> {
  const every = Math.max(1, Math.round((opts.everySec ?? 0.5) * opts.fps));
  const count = Math.max(1, Math.ceil((opts.durationSec * opts.fps) / every));
  const grid = chooseGrid(Math.min(count, 40), opts.aspect);
  const filter = [
    ...fit(grid),
    label(grid.thumbHeight),
    `select='not(mod(n\\,${every}))'`,
    `tile=${grid.cols}x${grid.rows}:padding=2:margin=2:color=0x111111`,
  ].join(",");
  await run("ffmpeg", ["-v", "error", "-y", "-i", opts.input, "-fps_mode", "passthrough", "-vf", filter, "-frames:v", "1", "-q:v", "4", opts.outPath]);
  return opts.outPath;
}

/** Extracts one full-resolution frame as PNG. */
export async function extractFrame(input: string, frame: number, outPath: string): Promise<string> {
  await run("ffmpeg", ["-v", "error", "-y", "-i", input, "-vf", `select='eq(n\\,${frame})'`, "-fps_mode", "passthrough", "-frames:v", "1", outPath]);
  return outPath;
}
