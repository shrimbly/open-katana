import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ProjectCard, ProjectEvent, ProjectPageData, RunState, RunStatus } from "../../../src/app/types.js";
import { app, MOCK } from "./api.js";

/**
 * The project page's live data: `GET /api/projects/:id/page` once, then full `RunState` snapshots and
 * export progress from the project channel (spec §7.7, D40). With `?mock=1&fixture=<name>` a fixture
 * stands in for the server (see `fixturePage` in fixtures/run.ts).
 */

export type ExportState = Extract<ProjectEvent, { type: "export" }>;

export interface ProjectView {
  page?: ProjectPageData;
  /** The latest run, kept current by the event stream. */
  run?: RunState;
  /** When `run` last arrived (ms), so the elapsed clock can tick between snapshots. */
  receivedAt: number;
  /** The last export event (Change the words, Use this take → Update video). */
  exporting?: ExportState;
  error?: string;
  reload(): Promise<void>;
}

/** Statuses that hold the project lock (spec §3.4). */
export const HOLDS_LOCK: RunStatus[] = ["queued", "starting", "running", "stopping", "paused"];
/** Statuses with a director process alive or about to be. */
export const ACTIVE: RunStatus[] = ["queued", "starting", "running", "stopping"];

export function useProject(id: string): ProjectView {
  const [page, setPage] = useState<ProjectPageData>();
  const [run, setRun] = useState<RunState>();
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [exporting, setExporting] = useState<ExportState>();
  const [error, setError] = useState<string>();
  const runId = useRef<string>();
  const runCreated = useRef("");

  const takeRun = (r: RunState | undefined) => {
    runId.current = r?.id;
    runCreated.current = r?.createdAt ?? "";
    setRun(r);
    setReceivedAt(Date.now());
  };

  const reload = useCallback(async () => {
    try {
      const p = MOCK ? await mockPage(id) : await app.page(id);
      setPage(p);
      takeRun(p.run);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setPage(undefined);
    takeRun(undefined);
    void reload();
    return app.projectEvents(
      id,
      (e) => {
        if (e.type === "run") {
          const next = (e as Extract<ProjectEvent, { type: "run" }>).state;
          // A newer run (Make another forks a project, so this is rare) replaces the one shown.
          if (!runId.current || next.id === runId.current || next.createdAt >= runCreated.current) {
            const finished = next.status === "done" && runId.current === next.id;
            takeRun(next);
            // A new version arrived: the page's version list and words changed with it.
            if (finished) void reload();
          }
        } else if (e.type === "export") {
          const x = e as ExportState;
          setExporting(x);
          if (x.state === "done") void reload();
        }
      },
      { onOpen: () => void reload() },
    );
  }, [id, reload]);

  return { page, run, receivedAt, exporting, error, reload };
}

async function mockPage(id: string): Promise<ProjectPageData> {
  const fixture = new URLSearchParams(location.search).get("fixture");
  if (!fixture) return app.page(id);
  const f = await import("./fixtures/run.js");
  return f.fixturePage(fixture);
}

/** The current time, re-rendering every `everyMs` while `active`. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

/** Elapsed seconds of a run, ticking locally between the server's snapshots. */
export function elapsedOf(run: RunState, receivedAt: number, now: number): number {
  const live = run.status === "running" || run.status === "starting" || run.status === "stopping";
  return run.elapsedSec + (live ? Math.max(0, (now - receivedAt) / 1000) : 0);
}

// ---------- formatting ----------

/** 846 → "14:06", 3725 → "1:02:05". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Minutes with at most one decimal: 18.24 → "18.2", 50 → "50". */
export function fmtMin(min: number): string {
  return String(Math.round(min * 10) / 10);
}

/** A clock time in the viewer's locale, e.g. "17:30". */
export function fmtWallClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "9:16" from width / height. */
export function fmtAspect(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}

/** Plural helper: plural(1, "shot") → "1 shot", plural(4, "shot") → "4 shots". */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "Show in Finder" on macOS, else the neutral wording. */
export const revealLabel = () => (/Mac/i.test(navigator.platform) ? "Show in Finder" : "Show in folder");

// ---------- project states ----------

type CardState = ProjectCard["state"];

/** The project card state a run's status maps to (spec §3.5). */
export function stateOfRun(status: RunStatus): CardState {
  if (status === "queued") return "queued";
  if (status === "paused") return "needs-you";
  if (status === "done") return "ready";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "stopped";
  return "making";
}

/** Pill copy (spec §4.11): "Making 38%" · "Up next" · "Needs your OK" · "Ready · v2" · … */
export function pillText(state: CardState, o: { pct?: number; versions?: number } = {}): string {
  switch (state) {
    case "making":
      return `Making ${Math.round(o.pct ?? 0)}%`;
    case "queued":
      return "Up next";
    case "needs-you":
      return "Needs your OK";
    case "ready":
      return o.versions ? `Ready · v${o.versions}` : "Ready";
    case "decoded":
      return "Decoded";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "chat":
      return "Made in a Claude Code chat";
  }
}

/** "17 Oct" in the viewer's locale. */
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
