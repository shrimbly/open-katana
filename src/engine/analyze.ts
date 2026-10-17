import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AudioAnalysis, analyzeAudio } from "./audio.js";
import { type CutDetection, detectCuts } from "./cuts.js";
import { type EnergyMap, buildEnergyMap } from "./energy.js";
import { extractFeatures } from "./frames.js";
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
}

/**
 * Full reference analysis: probe, native-frame cut/flash detection, global motion, audio beats,
 * energy map and contact sheets. Writes breakdown.json, energy.json, audio.json and sheets/ into outDir.
 */
export async function analyzeReference(input: string, outDir: string, opts: AnalyzeOptions): Promise<ReferenceAnalysis> {
  await mkdir(outDir, { recursive: true });
  const media = await probe(input);
  if (!media.video) throw new Error(`${input} has no video stream`);
  const v = media.video;
  const fps = rationalValue(v.fps) || 24;
  const pts = await framePts(input);
  const features = await extractFeatures(input, v.displayWidth, v.displayHeight);
  const cuts = detectCuts(features, pts, fps);
  const flashFrames = new Set<number>();
  for (const fl of cuts.flashes) for (let i = fl.startFrame; i <= fl.endFrame; i++) flashFrames.add(i);
  const motion = estimateMotion(features, new Set(cuts.shots.map((s) => s.startFrame)), flashFrames);
  // Cut times (on the audio's clock) let the tempo estimate check itself against the edit.
  const audioOffset = media.audio ? media.audio.startTimeSec - v.startTimeSec : 0;
  const cutTimes = cuts.shots.slice(1).map((sh) => sh.startSec - audioOffset);
  const audio = media.audio ? await analyzeAudio(input, { cuts: cutTimes, fps }).catch(() => undefined) : undefined;
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
  };

  const aspect = v.displayWidth / v.displayHeight;
  const sheetLabels = { t0: pts[0] ?? 0, shotStarts: cuts.shots.slice(1).map((s) => s.startFrame) };
  const sheetsDir = join(outDir, "sheets");
  const pages = opts.skipPages
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
  const overviewPath = join(outDir, "overview.jpg");
  await frameSheet({
    input,
    outPath: overviewPath,
    aspect,
    frames: cuts.shots.map((s) => Math.floor((s.startFrame + s.endFrame - 1) / 2)),
    label: sheetLabels,
  });

  await writeFile(join(outDir, "breakdown.json"), JSON.stringify(breakdown, null, 2));
  await writeFile(join(outDir, "energy.json"), JSON.stringify(energy, null, 2));
  if (audio) await writeFile(join(outDir, "audio.json"), JSON.stringify(audio));
  await writeFile(
    join(outDir, "motion.json"),
    JSON.stringify(motion.map((m) => ({ tx: round(m.tx, 4), ty: round(m.ty, 4), zoom: round(m.zoom, 4), rot: round(m.rot, 4), c: round(m.confidence, 2) }))),
  );
  await writeFile(join(outDir, "scores.json"), JSON.stringify(cuts.scores));

  return { media, breakdown, energy, audio, pages, overviewPath };
}
