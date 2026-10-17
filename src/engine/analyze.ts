import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIO_RATE, type AudioAnalysis, analyzeSamples, decodeMono } from "./audio.js";
import { type CutDetection, detectCuts, type FlashEvent, type Shot } from "./cuts.js";
import { type EnergyMap, buildEnergyMap } from "./energy.js";
import { extractFeatures, type FrameFeatures } from "./frames.js";
import { estimateMotion } from "./motion.js";
import { type MediaInfo, framePts, probe, rationalValue } from "./probe.js";
import { type SheetPage, everyFramePages, frameSheet } from "./sheets.js";
import { round } from "./stats.js";

export interface Breakdown {
  source: string;
  /** Measured source format; the output defaults to it unless the plan says otherwise. */
  format: {
    width: number;
    height: number;
    aspect: number;
    fps: { num: number; den: number };
    fpsValue: number;
    frameCount: number;
    durationSec: number;
    variableFrameRate: boolean;
    hasAudio: boolean;
    audioOffsetSec: number;
  };
  shots: CutDetection["shots"];
  flashes: CutDetection["flashes"];
  /** Mean colour of each shot (#rrggbb), flash frames left out. */
  shotColors?: string[];
}

export interface ReferenceAnalysis {
  media: MediaInfo;
  breakdown: Breakdown;
  energy: EnergyMap;
  audio?: AudioAnalysis;
  pages: SheetPage[];
  overviewPath: string;
}

export interface AnalyzeOptions {
  /** Seed for page check codes (use the project id so codes are stable per project). */
  seed: string;
  /** Skip every-frame pages (tests, quick looks). */
  skipPages?: boolean;
  /** Frames per review page; defaults to about one second (two or more for long references). */
  framesPerPage?: number;
  /** Progress, with the data each phase produced, so a caller can show results before the pages are done. */
  onPhase?: (e: AnalyzePhaseEvent) => void;
}

/** Progress of a reference analysis, with the data each phase produced (in this order). */
export type AnalyzePhaseEvent =
  | { phase: "probe"; media: MediaInfo }
  | { phase: "frames"; done: number; total: number } // every 60 frames, and once at the end
  | { phase: "cuts"; shots: Shot[]; flashes: FlashEvent[]; shotColors: string[] } // mean colour per shot as #rrggbb
  | { phase: "motion" }
  | { phase: "audio"; audio?: AudioAnalysis }
  | { phase: "energy"; energy: EnergyMap; breakdown: Breakdown } // everything but the review pages
  | { phase: "pages"; count: number }
  | { phase: "overview" };

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

/** Mean colour of each shot as #rrggbb, leaving out flash frames unless the shot is nothing but flash. */
export function shotColors(f: FrameFeatures, shots: Shot[], flashes: FlashEvent[]): string[] {
  const flash = new Set<number>();
  for (const fl of flashes) if (fl.kind !== "pulse") for (let i = fl.startFrame; i < fl.endFrame; i++) flash.add(i);
  return shots.map((s) => {
    const sum = [0, 0, 0];
    let n = 0;
    for (const skipFlash of [true, false]) {
      for (let i = s.startFrame; i < Math.min(s.endFrame, f.count); i++) {
        if (skipFlash && flash.has(i)) continue;
        for (let c = 0; c < 3; c++) sum[c]! += f.meanRgb[3 * i + c]!;
        n++;
      }
      if (n) break;
    }
    return n ? `#${sum.map((v) => hex2(v / n)).join("")}` : "#000000";
  });
}

/**
 * Full reference analysis: probe, native-frame cut/flash detection, global motion, audio beats,
 * energy map and contact sheets. Writes breakdown.json, energy.json, audio.json and sheets/ into outDir.
 * Everything but the sheets is written (and reported through `onPhase`) before the sheets start.
 */
export async function analyzeReference(input: string, outDir: string, opts: AnalyzeOptions): Promise<ReferenceAnalysis> {
  const emit = (e: AnalyzePhaseEvent) => opts.onPhase?.(e);
  await mkdir(outDir, { recursive: true });
  const [media, pts] = await Promise.all([probe(input), framePts(input)]);
  if (!media.video) throw new Error(`${input} has no video stream`);
  emit({ phase: "probe", media });
  const v = media.video;
  const fps = rationalValue(v.fps) || 24;
  // The audio decodes while the frames are read; its tempo waits for the cuts it is checked against.
  const samples = media.audio ? decodeMono(input).catch(() => undefined) : Promise.resolve(undefined);
  const total = v.frameCount || pts.length;
  let reported = 0;
  const features = await extractFeatures(input, v.displayWidth, v.displayHeight, 128, {
    onFrame: (n) => {
      if (n - reported < 60) return;
      reported = n;
      emit({ phase: "frames", done: n, total: Math.max(total, n) });
    },
  });
  emit({ phase: "frames", done: features.count, total: features.count });
  const cuts = detectCuts(features, pts, fps);
  const colors = shotColors(features, cuts.shots, cuts.flashes);
  emit({ phase: "cuts", shots: cuts.shots, flashes: cuts.flashes, shotColors: colors });
  const flashFrames = new Set<number>();
  for (const fl of cuts.flashes) for (let i = fl.startFrame; i <= fl.endFrame; i++) flashFrames.add(i);
  const motion = estimateMotion(features, new Set(cuts.shots.map((s) => s.startFrame)), flashFrames);
  emit({ phase: "motion" });
  // Cut times (on the audio's clock) let the tempo estimate check itself against the edit.
  const audioOffset = media.audio ? media.audio.startTimeSec - v.startTimeSec : 0;
  const cutTimes = cuts.shots.slice(1).map((sh) => sh.startSec - audioOffset);
  const mono = await samples;
  let audio: AudioAnalysis | undefined;
  try {
    audio = mono?.length ? analyzeSamples(mono, AUDIO_RATE, { cuts: cutTimes, fps }) : undefined;
  } catch {
    audio = undefined;
  }
  emit({ phase: "audio", audio });
  const durationSec = media.durationSec || features.count / fps;
  const energy = buildEnergyMap({ shots: cuts.shots, flashes: cuts.flashes, motion, pts, fps, durationSec, audio });

  const breakdown: Breakdown = {
    source: input,
    format: {
      width: v.displayWidth,
      height: v.displayHeight,
      aspect: round(v.displayWidth / v.displayHeight, 4),
      fps: v.fps,
      fpsValue: round(fps, 3),
      frameCount: features.count,
      durationSec: round(durationSec),
      variableFrameRate: v.variableFrameRate,
      hasAudio: Boolean(media.audio),
      audioOffsetSec: media.audio ? round(media.audio.startTimeSec - v.startTimeSec) : 0,
    },
    shots: cuts.shots,
    flashes: cuts.flashes,
    shotColors: colors,
  };

  await writeFile(join(outDir, "breakdown.json"), JSON.stringify(breakdown, null, 2));
  await writeFile(join(outDir, "energy.json"), JSON.stringify(energy, null, 2));
  if (audio) await writeFile(join(outDir, "audio.json"), JSON.stringify(audio));
  await writeFile(
    join(outDir, "motion.json"),
    JSON.stringify(motion.map((m) => ({ tx: round(m.tx, 4), ty: round(m.ty, 4), zoom: round(m.zoom, 4), rot: round(m.rot, 4), c: round(m.confidence, 2) }))),
  );
  await writeFile(join(outDir, "scores.json"), JSON.stringify(cuts.scores));
  emit({ phase: "energy", energy, breakdown });

  const aspect = v.displayWidth / v.displayHeight;
  const sheetLabels = { t0: pts[0] ?? 0, shotStarts: cuts.shots.slice(1).map((s) => s.startFrame) };
  const sheetsDir = join(outDir, "sheets");
  const overviewPath = join(outDir, "overview.jpg");
  // The pages and the overview are separate ffmpeg runs, so they go side by side. The overview's
  // outcome is held as a value until the pages are done, so a failure there is never unhandled.
  const overview = frameSheet({
    input,
    outPath: overviewPath,
    aspect,
    frames: cuts.shots.map((s) => Math.floor((s.startFrame + s.endFrame - 1) / 2)),
    label: sheetLabels,
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  let pages: SheetPage[];
  try {
    pages = opts.skipPages
      ? []
      : await everyFramePages({
          input,
          outDir: sheetsDir,
          aspect,
          framesPerPage: opts.framesPerPage ?? Math.min(60, Math.max(12, Math.round(fps * Math.max(1, Math.ceil(durationSec / 30))))),
          endFrame: features.count,
          seed: opts.seed,
          label: sheetLabels,
        });
  } catch (e) {
    await overview;
    throw e;
  }
  emit({ phase: "pages", count: pages.length });
  const overviewError = await overview;
  if (overviewError) throw overviewError;
  emit({ phase: "overview" });

  return { media, breakdown, energy, audio, pages, overviewPath };
}
