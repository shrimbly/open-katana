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

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  projects: () => fetch("/api/projects").then((r) => json<{ id: string; title: string; stage: string; updatedAt: string; versions: number }[]>(r)),
  project: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}`).then((r) => json<ProjectState>(r)),
  fonts: () => fetch("/api/fonts").then((r) => json<Record<string, FontInfo>>(r)),
  sfx: () => fetch("/api/sfx").then((r) => json<Record<string, string>>(r)),
  saveEdl: (id: string, edl: Edl) =>
    fetch(`/api/projects/${encodeURIComponent(id)}/edl`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(edl) }).then((r) =>
      json<{ ok: boolean; edl: Edl; warnings: string[] }>(r),
    ),
  render: (id: string, mode: "notext" | "preview" | "master") =>
    fetch(`/api/projects/${encodeURIComponent(id)}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) }).then((r) => json(r)),
  deliver: (id: string) => fetch(`/api/projects/${encodeURIComponent(id)}/deliver`, { method: "POST" }).then((r) => json<{ version: number; path: string; url: string; sizeMB: number }>(r)),
  waveform: (id: string, asset: string) => fetch(`/api/projects/${encodeURIComponent(id)}/waveform?asset=${encodeURIComponent(asset)}`).then((r) => json<{ perSec: number; peaks: number[] }>(r)),
  thumb: (id: string, asset: string, t: number, h = 96) => `/api/projects/${encodeURIComponent(id)}/thumb?asset=${encodeURIComponent(asset)}&t=${t.toFixed(2)}&h=${h}`,
  events: (id: string, onEvent: (e: Record<string, unknown>) => void) => {
    const source = new EventSource(`/api/projects/${encodeURIComponent(id)}/events`);
    source.onmessage = (m) => onEvent(JSON.parse(m.data));
    return () => source.close();
  },
};
