/**
 * Typed client for the app's HTTP API (spec §7). Every request that changes something sends `x-katana: 1`.
 * With `?mock=1` (remembered for the tab) the step-0 fixtures answer instead of the server, so screens can
 * be built and checked without a GPU, a director or any projects.
 */
import type {
  AppSettings,
  ContinueRun,
  DecodeState,
  Estimate,
  GlobalEvent,
  GpuSetupRequest,
  Info,
  LinkStatus,
  ProjectCard,
  ProjectEvent,
  ProjectPageData,
  RunDiagnostics,
  RunDraft,
  RunState,
  RunSummary,
  SaveTemplateRequest,
  SetupStatus,
  StartRun,
  TemplateCard,
  TemplateDetail,
  Upload,
  UploadPurpose,
  UserPick,
} from "../../../src/app/types.js";
import type { Edl } from "../../../src/render/edl.js";

/** A failed request: the server's `{ error, code?, hint?, ...extra }` body and the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MOCK_KEY = "katana-mock";
export const MOCK = (() => {
  const asked = new URLSearchParams(location.search).get("mock");
  try {
    if (asked !== null) sessionStorage.setItem(MOCK_KEY, asked === "1" ? "1" : "0");
    return sessionStorage.getItem(MOCK_KEY) === "1";
  } catch {
    return asked === "1";
  }
})();

/** `?mock=1&setup=nogpu`, `&estimate=h3`: picks a fixture variant, remembered for the tab like `mock`. */
function mockVariant(name: string): string | undefined {
  const asked = new URLSearchParams(location.search).get(name);
  try {
    if (asked !== null) sessionStorage.setItem(`katana-mock-${name}`, asked);
    return sessionStorage.getItem(`katana-mock-${name}`) ?? undefined;
  } catch {
    return asked ?? undefined;
  }
}

const enc = encodeURIComponent;
type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (MOCK) return (await mock(method, path, body)) as T;
  const headers: Record<string, string> = method === "GET" ? {} : { "x-katana": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const b = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    throw new ApiError(res.status, typeof b.error === "string" ? b.error : `HTTP ${res.status}`, typeof b.code === "string" ? b.code : undefined, b);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = (path: string) => request<void>("DELETE", path);

/** An upload in flight: resolves with the stored Upload; `abort()` cancels it. */
export interface UploadTask {
  promise: Promise<Upload>;
  abort(): void;
}

/** Sends a file as the raw request body (no multipart), reporting progress as 0–1. */
function upload(file: File, purpose: UploadPurpose, onProgress?: (fraction: number) => void): UploadTask {
  if (MOCK) {
    const promise = mock("POST", "/api/uploads", { name: file.name, purpose, bytes: file.size }).then((u) => {
      onProgress?.(1);
      return { ...(u as Upload), url: URL.createObjectURL(file) };
    });
    return { promise, abort: () => undefined };
  }
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Upload>((resolve, reject) => {
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("x-katana", "1");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-katana-filename", enc(file.name));
    xhr.setRequestHeader("x-katana-purpose", purpose);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // Not JSON: keep the status.
      }
      if (xhr.status === 201 || xhr.status === 200) resolve(body as unknown as Upload);
      else reject(new ApiError(xhr.status, typeof body.error === "string" ? body.error : `HTTP ${xhr.status}`, typeof body.code === "string" ? body.code : undefined, body));
    };
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Check that open-katana is still running."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled.", "ABORTED"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/**
 * Listens to a server-sent event channel. EventSource retries dropped connections itself; when the
 * server refuses or closes the channel this reconnects with backoff (1 s, doubling, at most 15 s).
 * `onOpen` runs on every (re)connect, so callers can refetch what they might have missed.
 */
export function subscribe<E>(path: string, onEvent: (e: E) => void, opts: { onOpen?: () => void } = {}): () => void {
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  let closed = false;
  const open = () => {
    source = new EventSource(path);
    source.onopen = () => {
      delay = 1000;
      opts.onOpen?.();
    };
    source.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as E);
      } catch {
        // Ignore a malformed event.
      }
    };
    source.onerror = () => {
      if (closed || source?.readyState !== EventSource.CLOSED) return;
      timer = setTimeout(open, delay);
      delay = Math.min(15_000, delay * 2);
    };
  };
  // A page going into the back/forward cache keeps its connections unless it closes them, and the
  // browser allows six per host: close on pagehide, reopen (and refetch) if the page comes back.
  const hide = () => {
    clearTimeout(timer);
    source?.close();
    source = undefined;
  };
  const show = (e: PageTransitionEvent) => {
    if (e.persisted && !closed && !source) open();
  };
  if (!MOCK) {
    open();
    addEventListener("pagehide", hide);
    addEventListener("pageshow", show);
  }
  return () => {
    closed = true;
    removeEventListener("pagehide", hide);
    removeEventListener("pageshow", show);
    hide();
  };
}

export const app = {
  // system
  info: () => get<Info>("/api/info"),
  setup: (fresh = false) => get<SetupStatus>(`/api/setup${fresh ? "?fresh=1" : ""}`),
  saveGpu: (req: GpuSetupRequest) => post<SetupStatus>("/api/setup/gpu", req),
  settings: () => get<AppSettings>("/api/settings"),
  saveSettings: (patch: Partial<AppSettings>) => put<AppSettings>("/api/settings", patch),
  events: (onEvent: (e: GlobalEvent) => void, opts?: { onOpen?: () => void }) => subscribe<GlobalEvent>("/api/events", onEvent, opts),

  // templates
  templates: () => get<{ templates: TemplateCard[] }>("/api/templates"),
  template: (slug: string) => get<TemplateDetail>(`/api/templates/${enc(slug)}`),
  saveTemplate: (req: SaveTemplateRequest) => post<TemplateDetail>("/api/templates", req),
  deleteTemplate: (slug: string) => del(`/api/templates/${enc(slug)}`),
  templateFile: (slug: string, file: string) => `/templates/${enc(slug)}/${enc(file)}`,

  // uploads
  upload,
  getUpload: (id: string) => get<Upload>(`/api/uploads/${enc(id)}`),
  /** An Instagram reel or post, fetched on this computer: its video to decode, or its sound as a track. */
  importLink: (url: string, purpose: "edit" | "music") => post<Upload>("/api/uploads/link", { url, purpose }),
  links: () => get<LinkStatus>("/api/links"),
  deleteUpload: (id: string) => del(`/api/uploads/${enc(id)}`),
  uploadMedia: (id: string) => `/uploads/${enc(id)}/media`,

  // decode
  decode: (req: { upload: string } | { fromProject: string }) => post<{ project: string; reused: boolean; state: DecodeState }>("/api/decode", req),
  decodeState: (project: string) => get<DecodeState>(`/api/projects/${enc(project)}/decode`),

  // runs
  estimate: (draft: RunDraft) => post<{ estimate: Estimate; prompt: string }>("/api/runs/estimate", draft),
  startRun: (req: StartRun) => post<{ run: RunState; project: string }>("/api/runs", req),
  runs: (active = false) => get<{ runs: RunSummary[] }>(`/api/runs${active ? "?active=1" : ""}`),
  run: (rid: string) => get<RunState>(`/api/runs/${enc(rid)}`),
  cancelRun: (rid: string) => post<RunSummary>(`/api/runs/${enc(rid)}/cancel`),
  continueRun: (rid: string, req: ContinueRun) => post<RunSummary>(`/api/runs/${enc(rid)}/continue`, req),
  startNow: (rid: string) => post<RunSummary>(`/api/runs/${enc(rid)}/start-now`),
  diagnostics: (rid: string) => get<RunDiagnostics>(`/api/runs/${enc(rid)}/diagnostics`),

  // projects
  projects: () => get<ProjectCard[]>("/api/projects"),
  page: (id: string) => get<ProjectPageData>(`/api/projects/${enc(id)}/page`),
  posterUrl: (id: string, h = 480) => `/api/projects/${enc(id)}/poster?h=${h}`,
  thumbUrl: (id: string, asset: string, t: number, h = 160) => `/api/projects/${enc(id)}/thumb?asset=${enc(asset)}&t=${t.toFixed(2)}&h=${h}`,
  deleteProject: (id: string) => del(`/api/projects/${enc(id)}`),
  reveal: (id: string, what: "latest" | "folder") => post<void>(`/api/projects/${enc(id)}/reveal`, { what }),
  exportProject: (id: string) => post<void>(`/api/projects/${enc(id)}/export`),
  pick: (id: string, pick: { line: string; asset: string }) => post<{ picks: UserPick[]; edlChanged: boolean }>(`/api/projects/${enc(id)}/picks`, pick),
  saveEdl: (id: string, edl: Edl) => put<{ ok: boolean; edl: Edl; warnings: string[] }>(`/api/projects/${enc(id)}/edl`, edl),
  /** The project channel: run, decode and export events plus the editor's own (edl, render, …). */
  projectEvents: (id: string, onEvent: (e: ProjectEvent | { type: string }) => void, opts?: { onOpen?: () => void }) =>
    subscribe<ProjectEvent | { type: string }>(`/api/projects/${enc(id)}/events`, onEvent, opts),
};

// ---------- ?mock=1 ----------

/** The hype receipt, following the draft's model choices so the receipt's switches can be tried. */
function mockEstimate(browse: typeof import("./fixtures/browse.js"), d: RunDraft): Estimate {
  const base = mockVariant("estimate") === "h3" && d.clipsModel !== "wan22" ? browse.hypeEstimateH3 : browse.hypeEstimate;
  if (!d.commercial) return base;
  return {
    ...base,
    key: `${base.key.slice(0, 12)}c0de`,
    groups: base.groups.map((g) => (g.label === "Keyframes" ? { ...g, profile: "boogu-edit", profileTitle: "Boogu Image Edit (identity keyframes)" } : g)),
    licences: base.licences.filter((l) => l.commercial !== "no"),
  };
}

/** Answers from the fixtures, loaded on first use so they stay out of the normal bundle. */
async function mock(method: Method, path: string, body: unknown): Promise<unknown> {
  const [browse, run] = await Promise.all([import("./fixtures/browse.js"), import("./fixtures/run.js")]);
  await new Promise((r) => setTimeout(r, 120));
  const url = new URL(path, location.origin);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // Ids and slugs sit third (/api/<group>/<id>/…); "estimate" and "gpu" are the only literal third parts.
  const route = `${method} /${parts.map((p, i) => (i === 2 && p !== "estimate" && p !== "gpu" ? ":id" : p)).join("/")}`;
  // As the server's summarize(): running rows carry their detail in the headline.
  const summary = (s: RunState): RunSummary => ({
    id: s.id,
    project: s.project,
    title: s.title,
    status: s.status,
    headline: s.status === "running" && s.detail ? `${s.headline} · ${s.detail}` : s.headline,
    pct: s.pct,
    attention: s.attention?.code,
    failure: s.failure?.code,
    queuePosition: s.queuePosition,
    updatedAt: s.updatedAt,
  });
  switch (route) {
    case "GET /api/info":
      return {
        name: "open-katana",
        version: "0.1.0",
        port: Number(location.port) || 4310,
        pid: 0,
        owner: true,
        features: ["app", "runs", "decode", "templates", "heic"],
      } satisfies Info;
    case "GET /api/setup":
      return browse.setupStates[mockVariant("setup") ?? "ready"] ?? browse.setupReady;
    case "POST /api/setup/gpu":
      return browse.setupReady;
    case "GET /api/settings":
    case "PUT /api/settings":
      return { model: "opus", maxParallelRuns: 1, defaultClaudeCapUsd: 15, keepAwake: true, licencesAcknowledged: [], ...(body as Partial<AppSettings>) } satisfies AppSettings;
    case "GET /api/links":
      return { instaloader: { found: true, version: "4.15.4", install: "pipx install instaloader" }, login: { mode: "none" } } satisfies LinkStatus;
    case "POST /api/uploads/:id": {
      // The link import: a reel's video or its sound.
      const b = body as { url: string; purpose: "edit" | "music" };
      const edit = b.purpose === "edit";
      return {
        id: Math.random().toString(16).slice(2, 10).padEnd(16, "0"),
        purpose: b.purpose,
        name: edit ? "@someone · DAbc12xY9.mp4" : "@someone · DAbc12xY9 sound.m4a",
        kind: edit ? "video" : "audio",
        bytes: edit ? 4_200_000 : 380_000,
        url: "",
        durationSec: 14.2,
        ...(edit ? { width: 1080, height: 1920, fps: 30, hasAudio: true } : { track: { bpm: 140, confidence: 0.9, dropSec: 6.1, durationSec: 14.2 } }),
        hash: "0".repeat(64),
        checks: [],
        createdAt: new Date().toISOString(),
      } satisfies Upload;
    }
    case "GET /api/templates":
      return { templates: browse.templates };
    case "GET /api/templates/:id": {
      const card = browse.templates.find((t) => t.slug === parts[2]);
      if (!card) break;
      return card.slug === "hype-energy" ? browse.hypeDetail : { ...browse.hypeDetail, ...card, structure: [], slots: [], words: [], brief: [] };
    }
    case "POST /api/uploads": {
      const b = body as { name: string; purpose: UploadPurpose; bytes: number };
      const kind = b.purpose === "photo" ? "image" : b.purpose === "edit" ? "video" : "audio";
      return {
        id: Math.random().toString(16).slice(2, 10).padEnd(16, "0"),
        purpose: b.purpose,
        name: b.name,
        kind,
        bytes: b.bytes,
        url: "",
        ...(kind === "image" ? { width: 1536, height: 2048 } : { durationSec: kind === "video" ? 16.4 : 182 }),
        ...(kind === "audio" ? { track: { bpm: 128, confidence: 0.82, dropSec: 47.8, durationSec: 182 } } : {}),
        hash: "0".repeat(64),
        checks: [],
        createdAt: new Date().toISOString(),
      } satisfies Upload;
    }
    case "POST /api/decode":
      return { project: run.DECODED_PROJECT, reused: false, state: run.decodeRunning };
    case "GET /api/projects/:id/decode":
      return run.decodeDone;
    case "POST /api/runs/estimate":
      return {
        estimate: mockEstimate(browse, body as RunDraft),
        prompt: 'Make the open-katana edit for project 20261017-hype-energy-a1b2.\n\nTEMPLATE: hype-energy ("Hype Energy"), shot-for-shot.',
      };
    case "POST /api/runs":
      return { run: run.runs.starting, project: run.PROJECT };
    case "GET /api/runs":
      // The fixtures share one run id; make them distinct so lists key properly.
      return { runs: [run.runs.running, run.pausedRuns.BUDGET_CAP, run.runs.queued].map((s, i) => ({ ...summary(s), id: i ? `${s.id.slice(0, -1)}${i}` : s.id })) };
    case "GET /api/runs/:id":
      return run.runs.running;
    case "POST /api/runs/:id/cancel":
      return summary(run.runs.stopping);
    case "POST /api/runs/:id/continue":
    case "POST /api/runs/:id/start-now":
      return summary(run.runs.running);
    case "GET /api/runs/:id/diagnostics":
      return { stderrTail: [], exitCode: 1, signal: null, sessionId: "6f1c2b9e-3a47-4d2e-9f0b-1c8e7a5d4b21", attempts: [], warnings: [] } satisfies RunDiagnostics;
    case "GET /api/projects":
      return run.projects;
    case "GET /api/projects/:id/page":
      return parts[2] === run.DECODED_PROJECT ? run.decodedPage : run.resultPage;
    case "POST /api/projects/:id/picks":
      // The mock's project page is a finished edit, so a pick swaps into its cut.
      return { picks: [{ ...(body as { line: string; asset: string }), at: new Date().toISOString() }], edlChanged: true };
    case "DELETE /api/projects/:id":
    case "DELETE /api/templates/:id":
    case "DELETE /api/uploads/:id":
    case "POST /api/projects/:id/reveal":
    case "POST /api/projects/:id/export":
      return undefined;
  }
  throw new ApiError(501, `Not in the mock: ${method} ${url.pathname}`, "MOCK");
}
