import type { Breakdown } from "../engine/analyze.js";
import type { AudioAnalysis } from "../engine/audio.js";
import type { FlashEvent, Shot } from "../engine/cuts.js";
import type { EnergyMap } from "../engine/energy.js";
import type { MediaInfo } from "../engine/probe.js";
import { analyzeProject, type AnalyzePhaseEvent, type StoredPage } from "../project/analysis.js";
import type { Workspace } from "../project/workspace.js";
import { cutMapFromAnalysis, detectedLayers } from "./cutmap.js";
import { decodeRead } from "./decode-copy.js";
import { withProject } from "./projects.js";
import type { CutMapData, DecodePhase, DecodeState } from "./types.js";

// The app's decode (spec §11.2): the same analysis katana_analyze runs, in-process and one at a time,
// with a DecodeState emitted after every phase so the Cut Map draws itself as the data arrives. The
// result is "ready" (everything the decode page shows) once the energy map exists, and "done" when the
// director's review pages are written too. analysis/decode.json keeps the final state.

const PHASES: DecodePhase[] = ["upload", "probe", "frames", "cuts", "motion", "audio", "energy", "palette", "pages", "overview"];
const MIN_SEC = 2;
const MAX_SEC = 60;
const FILE = "analysis/decode.json";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

class DecodeError extends Error {
  constructor(
    readonly code: NonNullable<DecodeState["error"]>["code"],
    message: string,
  ) {
    super(message);
  }
}

/** One decode in progress: its state plus what the phases have produced so far. */
interface Job {
  state: DecodeState;
  startedAt: number;
  media?: MediaInfo;
  shots?: Shot[];
  flashes?: FlashEvent[];
  colors?: string[];
  audio?: AudioAnalysis;
  done: Promise<void>;
}

export class DecodeManager {
  private readonly emit: (project: string, state: DecodeState) => void;
  private readonly jobs = new Map<string, Job>();
  /** FIFO: each decode starts when the one before it has finished. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: { emit: (project: string, state: DecodeState) => void }) {
    this.emit = opts.emit;
  }

  /**
   * Queues a decode of the project's reference and returns its state at once. A project already
   * decoded (or being decoded) returns that state instead; a failed decode is tried again.
   */
  async start(ws: Workspace, name: string): Promise<DecodeState> {
    const id = ws.project.id;
    const saved = await ws.readJson<DecodeState>(FILE).catch(() => undefined);
    // Checked after the read, so two starts at once share one decode.
    const running = this.jobs.get(id);
    if (running) return running.state;
    if (saved && saved.status !== "error") return saved;
    const ref = ws.reference();
    const state: DecodeState = {
      project: id,
      name,
      videoUrl: ref ? `/media/${encodeURIComponent(id)}/${ref.path.split("/").map(encodeURIComponent).join("/")}` : "",
      status: "running",
      phases: PHASES.map((p) => ({ id: p, state: p === "upload" ? "done" : "todo" })),
    };
    const job: Job = { state, startedAt: 0, done: Promise.resolve() };
    this.jobs.set(id, job);
    job.done = this.queue = this.queue.then(() => this.run(ws, job));
    this.emit(id, state);
    return state;
  }

  /** The state of a decode in progress, else the saved final state (undefined when the project was never decoded). */
  async get(ws: Workspace): Promise<DecodeState | undefined> {
    return this.jobs.get(ws.project.id)?.state ?? (await ws.readJson<DecodeState>(FILE).catch(() => undefined));
  }

  /** Resolves when the project's decode (if one is queued or running) has finished. */
  async settled(projectId: string): Promise<void> {
    await this.jobs.get(projectId)?.done;
  }

  private update(job: Job, patch: Partial<DecodeState>, phases: Partial<Record<DecodePhase, Partial<DecodeState["phases"][number]>>> = {}): void {
    const s = job.state;
    job.state = {
      ...s,
      ...patch,
      phases: s.phases.map((p) => (phases[p.id] ? { ...p, ...phases[p.id] } : p)),
    };
    this.emit(s.project, job.state);
  }

  /** The Cut Map as far as the data goes: shots and flashes after the cuts, beats after the audio. */
  private partialMap(job: Job): CutMapData | undefined {
    const v = job.media?.video;
    if (!v || !job.shots) return undefined;
    return {
      durationSec: r3(job.media!.durationSec || job.shots.at(-1)!.endSec),
      aspect: r3(v.displayWidth / Math.max(1, v.displayHeight)),
      ...detectedLayers({ shots: job.shots, flashes: job.flashes ?? [], shotColors: job.colors, fps: v.fps.den ? v.fps.num / v.fps.den : 24 }),
      beats: job.audio?.beats ?? [],
      downbeats: job.audio?.downbeats ?? [],
      text: [],
    };
  }

  private onPhase(job: Job, e: AnalyzePhaseEvent): void {
    switch (e.phase) {
      case "probe": {
        job.media = e.media;
        const v = e.media.video;
        if (!v) throw new DecodeError("NO_VIDEO_STREAM", "We couldn't find any picture in that file.");
        const durationSec = e.media.durationSec;
        if (durationSec > MAX_SEC) throw new DecodeError("TOO_LONG", `That edit is ${Math.round(durationSec)} s long. Decode works on up to ${MAX_SEC} s. Trim it to the part you love.`);
        if (durationSec < MIN_SEC) throw new DecodeError("TOO_SHORT", "That's under 2 seconds, so there's no rhythm to copy yet.");
        const fps = v.fps.den ? v.fps.num / v.fps.den : 24;
        return this.update(
          job,
          { format: { width: v.displayWidth, height: v.displayHeight, fps: r3(fps), durationSec: r3(durationSec), hasAudio: Boolean(e.media.audio) } },
          { probe: { state: "done" }, frames: { state: "now", done: 0, total: v.frameCount } },
        );
      }
      case "frames": {
        const finished = e.done >= e.total;
        return this.update(job, {}, { frames: { state: finished ? "done" : "now", done: e.done, total: e.total }, ...(finished ? { cuts: { state: "now" } } : {}) });
      }
      case "cuts":
        job.shots = e.shots;
        job.flashes = e.flashes;
        job.colors = e.shotColors;
        return this.update(job, { cutMap: this.partialMap(job) }, { cuts: { state: "done" }, palette: { state: "done" }, motion: { state: "now" } });
      case "motion":
        return this.update(job, {}, { motion: { state: "done" }, audio: { state: "now" } });
      case "audio":
        job.audio = e.audio;
        return this.update(job, { cutMap: this.partialMap(job) }, { audio: { state: "done" }, energy: { state: "now" } });
      case "energy":
        return this.ready(job, e.breakdown, e.energy);
      case "pages":
        return this.update(job, { pages: e.count }, { pages: { state: "done", done: e.count, total: e.count }, overview: { state: "now" } });
      case "overview":
        return this.update(job, {}, { overview: { state: "done" } });
    }
  }

  /** Everything the decode page shows is known: stats, the plain read, the full Cut Map and the shot strip. */
  private ready(job: Job, breakdown: Breakdown, energy: EnergyMap): void {
    const s = energy.summary;
    const audio = job.audio;
    const project = job.state.project;
    const cutMap = cutMapFromAnalysis({ breakdown, energy, audio, shotColors: job.colors });
    const f = breakdown.format;
    const framesPerPage = Math.min(60, Math.max(12, Math.round(f.fpsValue * Math.max(1, Math.ceil(f.durationSec / 30)))));
    const pages = Math.ceil(f.frameCount / framesPerPage);
    this.update(
      job,
      {
        status: "ready",
        tookMs: Date.now() - job.startedAt,
        stats: {
          shots: breakdown.shots.length,
          cuts: Math.max(0, breakdown.shots.length - 1),
          flashes: breakdown.flashes.length,
          ...(audio && audio.tempoBpm > 0 ? { bpm: Math.round(audio.tempoBpm), tempoSource: audio.tempoSource ?? "audio" } : {}),
          cutsOnBeat: s.cutsOnBeatShare,
          cutsPerSec: s.cutsPerSecond,
          meanShotSec: s.meanShotSec,
          punches: energy.events.filter((e) => e.type === "punch").length,
          shakeSec: s.shakeSeconds,
        },
        read: decodeRead({ breakdown, energy, audio }),
        cutMap,
        shots: breakdown.shots.map((sh, index) => {
          const mid = (sh.startSec + sh.endSec) / 2;
          return { index, start: sh.startSec, end: sh.endSec, color: job.colors?.[index] ?? "#000000", thumb: `/api/projects/${encodeURIComponent(project)}/thumb?asset=ref&t=${mid.toFixed(2)}&h=120` };
        }),
      },
      { energy: { state: "done" }, pages: { state: "now", done: 0, total: pages } },
    );
  }

  /** A reference analysed before (by katana_analyze in a chat, or a decode cut short): its state from the saved files. */
  private async fromDisk(ws: Workspace, job: Job): Promise<void> {
    const breakdown = (await ws.readJson<Breakdown>("analysis/breakdown.json"))!;
    const energy = await ws.readJson<EnergyMap>("analysis/energy.json");
    if (!energy) throw new DecodeError("DECODE_FAILED", "We couldn't decode that video. Try exporting it again as MP4.");
    job.audio = await ws.readJson<AudioAnalysis>("analysis/audio.json");
    job.colors = breakdown.shotColors;
    const f = breakdown.format;
    this.update(job, { format: { width: f.width, height: f.height, fps: f.fpsValue, durationSec: f.durationSec, hasAudio: f.hasAudio } });
    this.ready(job, breakdown, energy);
    const pages = (await ws.readJson<StoredPage[]>("analysis/pages.json"))?.length ?? 0;
    this.update(job, { pages, tookMs: Date.now() - job.startedAt }, { pages: { state: "done", done: pages, total: pages } });
  }

  private async run(ws: Workspace, job: Job): Promise<void> {
    const id = ws.project.id;
    job.startedAt = Date.now();
    try {
      this.update(job, {}, { probe: { state: "now" } });
      // project.json is written at the end (stage, review reset), so the analysis runs inside the
      // app's per-project write queue, on a freshly opened workspace.
      await withProject(id, async (fresh: Workspace) => {
        if (!fresh.reference()) throw new DecodeError("NO_VIDEO_STREAM", "We couldn't find any picture in that file.");
        // Errors found at the probe (length, no picture) stop the analysis; later phases only record them.
        let failure: unknown;
        const r = await analyzeProject(fresh, {
          onPhase: (e) => {
            if (e.phase === "probe") return this.onPhase(job, e);
            if (failure) return;
            try {
              this.onPhase(job, e);
            } catch (err) {
              failure = err;
            }
          },
        });
        if (failure) throw failure;
        if (r.reused) await this.fromDisk(fresh, job);
      });
      this.update(job, { status: "done" }, Object.fromEntries(PHASES.map((p) => [p, { state: "done" }])));
    } catch (e) {
      const err = e instanceof DecodeError ? e : /no video stream/i.test((e as Error)?.message ?? "") ? new DecodeError("NO_VIDEO_STREAM", "We couldn't find any picture in that file.") : undefined;
      this.update(job, {
        status: "error",
        error: { code: err?.code ?? "DECODE_FAILED", message: err?.message ?? "We couldn't decode that video. Try exporting it again as MP4." },
      });
    } finally {
      await ws.writeJson(FILE, job.state).catch(() => undefined);
      this.jobs.delete(id);
    }
  }
}
