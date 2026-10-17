import type { Edl } from "../../src/render/edl.js";

export type { Edl };
export type ShotT = Edl["shots"][number];
export type TextT = Edl["text"][number];
export type FlashT = Edl["flashes"][number];
export type SfxT = Edl["sfx"][number];

export interface AssetT {
  id: string;
  kind: "image" | "video" | "audio";
  role: string;
  label?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  url: string;
  verdict?: string;
}

export interface RenderInfo {
  url: string;
  mtime: number;
}

export interface ProjectState {
  project: { id: string; title: string; stage: string; versions: { version: number; path: string; note?: string }[] };
  edl?: Edl;
  beats: number[];
  reference?: { format: { width: number; height: number; fpsValue: number }; shots: { startSec: number; endSec: number }[] };
  assets: AssetT[];
  renders: { preview?: RenderInfo; master?: RenderInfo; notext?: RenderInfo };
  render?: { mode: string; running: boolean; done: number; total: number; error?: string };
  check: string[];
}

export interface FontInfo {
  url: string;
  style: string;
  metrics?: { unitsPerEm: number; winAscent: number; winDescent: number; capHeight: number };
}

/** Sent on every request that changes something; the server refuses those without it. */
const INTENT = { "x-katana": "1" };

/** A refused request; `code` is the server's machine-readable reason (e.g. RUN_ACTIVE). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new HttpError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
  return body as T;
}

/** What the editor needs from the app's project page: whether a run holds the edit, and whether the app made it. */
export interface AppProjectInfo {
  locked: boolean;
  card: { origin: "template" | "decode" | "chat" };
  run?: { id: string; status: string };
}

export const api = {
  projects: () => fetch("/api/projects").then((r) => json<{ id: string; title: string; stage: string; updatedAt: string; versions: number }[]>(r)),
  project: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}`).then((r) => json<ProjectState>(r)),
  appInfo: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}/page`).then((r) => json<AppProjectInfo>(r)),
  fonts: () => fetch("/api/fonts").then((r) => json<Record<string, FontInfo>>(r)),
  sfx: () => fetch("/api/sfx").then((r) => json<Record<string, string>>(r)),
  saveEdl: (id: string, edl: Edl) =>
    fetch(`/api/projects/${encodeURIComponent(id)}/edl`, { method: "PUT", headers: { ...INTENT, "content-type": "application/json" }, body: JSON.stringify(edl) }).then((r) =>
      json<{ ok: boolean; edl: Edl; warnings: string[] }>(r),
    ),
  render: (id: string, mode: "notext" | "preview" | "master") =>
    fetch(`/api/projects/${encodeURIComponent(id)}/render`, { method: "POST", headers: { ...INTENT, "content-type": "application/json" }, body: JSON.stringify({ mode }) }).then((r) => json(r)),
  deliver: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}/deliver`, { method: "POST", headers: INTENT }).then((r) => json<{ version: number; path: string; url: string; sizeMB: number }>(r)),
  waveform: (id: string, asset: string) => fetch(`/api/projects/${encodeURIComponent(id)}/waveform?asset=${encodeURIComponent(asset)}`).then((r) => json<{ perSec: number; peaks: number[] }>(r)),
  thumb: (id: string, asset: string, t: number, h = 96) => `/api/projects/${encodeURIComponent(id)}/thumb?asset=${encodeURIComponent(asset)}&t=${t.toFixed(2)}&h=${h}`,
  events: (id: string, onEvent: (e: Record<string, unknown>) => void) => {
    let source: EventSource | undefined;
    const open = () => {
      source = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
      source.onmessage = (m) => onEvent(JSON.parse(m.data));
    };
    // Closed while the page sits in the back/forward cache, so it doesn't hold one of the browser's
    // six connections to the server; reopened when the page comes back.
    const hide = () => {
      source?.close();
      source = undefined;
    };
    const show = (e: PageTransitionEvent) => {
      if (e.persisted && !source) open();
    };
    open();
    addEventListener("pagehide", hide);
    addEventListener("pageshow", show);
    return () => {
      removeEventListener("pagehide", hide);
      removeEventListener("pageshow", show);
      hide();
    };
  },
};
