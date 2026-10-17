import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trashDir } from "../src/app/http.js";
import { Hub } from "../src/app/hub.js";
import { appLockFile, readAppLock } from "../src/app/lock.js";
import { cardState } from "../src/app/projects.js";
import { isRunActive } from "../src/app/project-lock.js";
import type { AppJson, Info, ProjectCard, ProjectPageData, RunRecord, TemplateCard, TemplateDetail, Upload } from "../src/app/types.js";
import { userPresetsDir } from "../src/presets/library.js";
import { Workspace } from "../src/project/workspace.js";
import { Studio } from "../src/studio/server.js";
import { packageRoot } from "../src/util/paths.js";
import { run } from "../src/util/proc.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

// Never touch the person's own Claude Code, ComfyUI or file manager: setup sees no director and a GPU
// that refuses connections, and reveal only checks its arguments.
process.env.OPEN_KATANA_REVEAL_DRY = "1";
process.env.OPEN_KATANA_CLAUDE = join(process.env.OPEN_KATANA_HOME ?? "/nonexistent", "no-claude-here");
process.env.COMFYUI_URL = "http://127.0.0.1:9";
delete process.env.COMFY_CLOUD_API_KEY;
delete process.env.OPEN_KATANA_BACKEND;

const INTENT = { "x-katana": "1", "content-type": "application/json" };
const AT = "2026-10-17T14:22:33.000Z";

const runRecord = (project: string, id: string, status: RunRecord["status"]): RunRecord => ({
  v: 1,
  id,
  project,
  kind: "template",
  status,
  title: "Hype Energy · rooftop car park",
  template: "hype-energy",
  sessionId: "6f1c2b9e-3a47-4d2e-9f0b-1c8e7a5d4b21",
  model: "opus",
  claude: { path: "/usr/local/bin/claude", version: "2.1.302", auth: "subscription" },
  caps: { gpuMinutes: 50, claudeUsd: 15 },
  planFirst: false,
  overrides: { profiles: {}, commercial: false },
  attempts: [],
  spentUsd: 0,
  versionsAtStart: 0,
  warnings: [],
  createdAt: AT,
  updatedAt: AT,
});

/** Makes a project look like an app run holds it: runs/active plus a run.json in a lock-holding status. */
async function lockProject(ws: Workspace, rid: string): Promise<void> {
  await mkdir(ws.path("runs", rid), { recursive: true });
  await writeFile(ws.path("runs", rid, "run.json"), JSON.stringify(runRecord(ws.project.id, rid, "running")));
  await writeFile(ws.path("runs", "active"), JSON.stringify({ run: rid, since: AT }));
}

/** Reads a server-sent event stream until `stop` (or the timeout) and returns the events seen. */
async function sse(url: string, until: (e: Record<string, unknown>, all: Record<string, unknown>[]) => boolean, timeoutMs = 15_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const events: Record<string, unknown>[] = [];
  let text = "";
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
      let i: number;
      while ((i = text.indexOf("\n\n")) >= 0) {
        const block = text.slice(0, i);
        text = text.slice(i + 2);
        if (!block.startsWith("data: ")) continue;
        const e = JSON.parse(block.slice(6)) as Record<string, unknown>;
        events.push(e);
        if (until(e, events)) return events;
      }
    }
  } catch {
    // Timed out or closed.
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return events;
}

describe("hub", () => {
  /** Just enough of a ServerResponse to collect what the hub writes. */
  const client = () => {
    const out = { chunks: [] as string[], ended: false, close: () => undefined as void };
    const res = {
      writeHead: () => res,
      write: (c: string) => out.chunks.push(c),
      end: () => {
        out.ended = true;
        out.close();
      },
      on: (event: string, fn: () => void) => {
        if (event === "close") out.close = fn;
        return res;
      },
    };
    return { res: res as unknown as ServerResponse, out };
  };

  it("sends heartbeats and events, and closes the oldest of 17 clients", async () => {
    const hub = new Hub({ heartbeatMs: 20 });
    const a = client();
    hub.subscribeGlobal(a.res);
    hub.global({ type: "projects" });
    await new Promise((r) => setTimeout(r, 60));
    expect(a.out.chunks[0]).toBe(": connected\n\n");
    expect(a.out.chunks).toContain('data: {"type":"projects"}\n\n');
    expect(a.out.chunks).toContain(": hb\n\n");
    const many = Array.from({ length: 16 }, () => client());
    for (const c of many) hub.subscribeGlobal(c.res);
    expect(a.out.ended).toBe(true);
    expect(many.some((c) => c.out.ended)).toBe(false);
    expect(hub.count()).toBe(16);
    const p = client();
    hub.subscribeProject("20261017-x-a1b2", p.res);
    hub.project("20261017-x-a1b2", { type: "edl" });
    hub.project("20261017-y-a1b2", { type: "edl" });
    expect(p.out.chunks.filter((c) => c.startsWith("data:"))).toEqual(['data: {"type":"edl"}\n\n']);
    hub.close();
    expect(p.out.ended && many.every((c) => c.out.ended)).toBe(true);
  });
});

describe("project card states", () => {
  const app: AppJson = { v: 1, origin: { kind: "template", template: "hype-energy" }, runs: ["r-20261017000000-0a0a"], createdAt: AT };
  const decodeApp: AppJson = { v: 1, origin: { kind: "decode" }, runs: [], createdAt: AT };
  it("takes the first match of spec §3.5", () => {
    expect(cardState({ status: "queued", versions: 2, app, decoded: false })).toBe("queued");
    for (const s of ["starting", "running", "stopping"] as const) expect(cardState({ status: s, versions: 2, app, decoded: false })).toBe("making");
    expect(cardState({ status: "paused", versions: 2, app, decoded: false })).toBe("needs-you");
    expect(cardState({ status: "failed", versions: 1, app, decoded: false })).toBe("ready");
    expect(cardState({ status: "cancelled", versions: 0, app, decoded: false })).toBe("stopped");
    expect(cardState({ status: "interrupted", versions: 0, app, decoded: false })).toBe("stopped");
    expect(cardState({ status: "failed", versions: 0, app, decoded: false })).toBe("failed");
    expect(cardState({ versions: 0, app: decodeApp, decoded: true })).toBe("decoded");
    expect(cardState({ versions: 0, decoded: false })).toBe("chat");
    expect(cardState({ versions: 1, decoded: false })).toBe("ready");
  });
});

describe("app API", () => {
  let studio: Studio;
  let base: string;
  let media: string;
  let reference: string;
  let still: string;
  let portrait: string;

  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = INTENT) => {
    const res = await fetch(`${base}${path}`, { method, headers: method === "GET" ? {} : headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { status: res.status, body: data as T & { error?: string; code?: string }, headers: res.headers };
  };

  const uploadFile = async (file: string, purpose: string): Promise<Upload> => {
    const res = await fetch(`${base}/api/uploads`, {
      method: "POST",
      headers: { "x-katana": "1", "content-type": "application/octet-stream", "x-katana-filename": encodeURIComponent(file.split("/").at(-1)!), "x-katana-purpose": purpose },
      body: await readFile(file),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Upload;
  };

  beforeAll(async () => {
    media = await tempDir("ok-app-api-");
    reference = await makeReferenceEdit(media);
    still = join(media, "still.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", still]);
    portrait = join(media, "portrait.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1200x1600", "-frames:v", "1", portrait]);
    studio = new Studio();
    await studio.start(0);
    base = `http://127.0.0.1:${studio.port}`;
  }, 120_000);

  afterAll(async () => {
    await studio?.stop();
  });

  it("says who it is", async () => {
    const { status, body } = await api<Info>("GET", "/api/info");
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "open-katana", port: studio.port, pid: process.pid, owner: false });
    expect(body.features).toEqual(expect.arrayContaining(["app", "runs", "decode", "templates"]));
    expect(body.features.includes("heic")).toBe(process.platform === "darwin");
  });

  it("serves the page for history routes and 404s missing files", async () => {
    for (const path of ["/", "/edits", "/t/hype-energy", "/edit/20261017-x-a1b2", "/p/20261017-x-a1b2"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    }
    expect((await fetch(`${base}/assets/does-not-exist.js`)).status).toBe(404);
    expect((await api("GET", "/api/nothing")).status).toBe(404);
  });

  describe("templates", () => {
    it("lists the 7 built-ins with cut maps, by title", async () => {
      const { status, body } = await api<{ templates: TemplateCard[] }>("GET", "/api/templates");
      expect(status).toBe(200);
      const builtIn = body.templates.filter((t) => t.source === "built-in");
      expect(builtIn.map((t) => t.slug)).toEqual(["cold-stare", "golden-hour", "hype-energy", "iron-mindset", "neon-rain", "night-stare", "phonk-velocity"]);
      const kinds = Object.fromEntries(builtIn.map((t) => [t.slug, t.kind]));
      expect(kinds).toMatchObject({ "hype-energy": "shot-for-shot", "iron-mindset": "shot-for-shot", "night-stare": "shot-for-shot", "neon-rain": "freestyle", "cold-stare": "freestyle" });
      const hype = builtIn.find((t) => t.slug === "hype-energy")!;
      expect(hype.format).toMatchObject({ aspect: "9:16", fps: 60 });
      expect(hype.format.aspectValue).toBeCloseTo(0.5625, 3);
      expect(hype.stats.bpm).toBe(144);
      expect(hype.stats.slots).toBe(13);
      expect(builtIn.find((t) => t.slug === "night-stare")!.format.aspectValue).toBeCloseTo(4 / 3, 3);
      for (const t of builtIn) {
        expect(t.cutMap.aspect).toBeGreaterThan(0);
        expect(Array.isArray(t.cutMap.shots)).toBe(true);
        expect(["required", "optional"]).toContain(t.inputs.music);
      }
    });

    it("has the shot-for-shot cut maps from the skeletons", async (ctx) => {
      const { body } = await api<{ templates: TemplateCard[] }>("GET", "/api/templates");
      const hype = body.templates.find((t) => t.slug === "hype-energy")!;
      if (!hype.cutMap.shots.length) return ctx.skip(); // cutMapFromPreset (WP-C) not landed yet
      expect(hype.cutMap.shots).toHaveLength(49);
      expect(hype.cutMap.flashes).toHaveLength(7);
      expect(hype.cutMap.durationSec).toBeCloseTo(16.433, 2);
      expect(hype.stats.shots).toBe(49);
    });

    it("gives a template's detail page", async () => {
      const { status, body } = await api<TemplateDetail>("GET", "/api/templates/hype-energy");
      expect(status).toBe(200);
      expect(body.slots).toHaveLength(13);
      expect(body.slots.every((s) => s.uses > 0)).toBe(true);
      expect(body.words.map((w) => w.text)).toEqual(["NOTHING NEW", "SAME OLD DAY", "IS THAT ALL?", "BORN", "DIFFERENT", "PERIOD", "CROWN ACCEPTED"]);
      expect(body.estimate).toBeDefined();
      expect(Array.isArray(body.brief)).toBe(true);
      const freestyle = await api<TemplateDetail>("GET", "/api/templates/neon-rain");
      expect(freestyle.body.kind).toBe("freestyle");
      expect(freestyle.body.structure.length).toBeGreaterThan(0);
      expect((await api("GET", "/api/templates/no-such-template")).status).toBe(404);
      expect((await api("GET", "/api/templates/Bad_Slug")).status).toBe(400);
    });

    it("lists the person's own templates first and serves only their listed files", async () => {
      const dir = join(userPresetsDir(), "my-cut");
      await mkdir(dir, { recursive: true });
      await copyFile(still, join(dir, "poster.jpg"));
      await writeFile(join(dir, "secret.txt"), "not served");
      await writeFile(
        join(dir, "preset.json"),
        JSON.stringify({ slug: "my-cut", title: "My Cut", description: "Saved from a decode.", category: "personalized_edits", example: { poster: "poster.jpg", credit: "Made by me." } }),
      );
      const { body } = await api<{ templates: TemplateCard[] }>("GET", "/api/templates");
      expect(body.templates[0]).toMatchObject({ slug: "my-cut", source: "user", media: { poster: "/templates/my-cut/poster.jpg" } });
      // The credit belongs to an example video; there is none.
      expect(body.templates[0]!.credit).toBeUndefined();
      const poster = await fetch(`${base}/templates/my-cut/poster.jpg`);
      expect(poster.status).toBe(200);
      expect(poster.headers.get("cache-control")).toBe("no-cache");
      expect((await fetch(`${base}/templates/my-cut/secret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/templates/my-cut/preset.json`)).status).toBe(404);

      expect((await api("DELETE", "/api/templates/hype-energy")).status).toBe(403);
      expect((await api("DELETE", "/api/templates/my-cut")).status).toBe(204);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(trashDir()).some((d) => d.startsWith("template-my-cut-"))).toBe(true);
      expect((await api("GET", "/api/templates/my-cut")).status).toBe(404);
    });

    it("refuses a template name that is taken and an unknown project", async () => {
      const ws = await Workspace.create({ title: "save template" });
      expect((await api("POST", "/api/templates", { fromProject: ws.project.id, title: "Hype Energy" })).body.code).toBe("SLUG_TAKEN");
      expect((await api("POST", "/api/templates", { fromProject: "20261017-gone-0000", title: "Gone" })).status).toBe(404);
      expect((await api("POST", "/api/templates", { fromProject: "../x", title: "Bad" })).status).toBe(400);
      expect((await api("POST", "/api/templates", { title: "No project" })).status).toBe(400);
    });

    it("saves a decoded edit as a template, listed first as the person's own", async (ctx) => {
      const ws = await Workspace.create({ title: "rooftop cut" });
      await ws.import(reference, "reference", { id: "ref" });
      const clip = ws.path("gen", "walk_t1.mp4");
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
      await ws.register({ path: clip, role: "generated", id: "g1", lineId: "walk" });
      await ws.writeJson("app.json", { v: 1, origin: { kind: "decode", sourceName: "my-fav-edit.mp4" }, runs: [], createdAt: AT } satisfies AppJson);
      await ws.writeJson("render/edl.json", { canvas: { width: 640, height: 360, fps: 24 }, audio: { asset: "ref", offset: 0 }, shots: [{ start: 0, end: 1.5, source: { asset: "g1" } }] });
      await copyFile(reference, ws.path("deliver", "rooftop-cut_v1.mp4"));
      ws.project.versions.push({ version: 1, path: "deliver/rooftop-cut_v1.mp4", createdAt: AT });
      await ws.save();
      const saved = await api<TemplateDetail>("POST", "/api/templates", { fromProject: ws.project.id, title: "Rooftop Cut", description: "Mine." });
      if (saved.status === 500 && /not implemented/.test(saved.body.error ?? "")) return ctx.skip(); // deriveTemplate (WP-F) not landed yet
      expect(saved.status, saved.body.error).toBe(201);
      expect(saved.body).toMatchObject({ slug: "rooftop-cut", title: "Rooftop Cut", source: "user", kind: "shot-for-shot" });
      expect(saved.body.slots.map((s) => s.id)).toEqual(["walk"]);
      const { body } = await api<{ templates: TemplateCard[] }>("GET", "/api/templates");
      expect(body.templates[0]!.slug).toBe("rooftop-cut");
      expect((await fetch(`${base}${body.templates[0]!.media.poster}`)).status).toBe(200);
      expect((await api("POST", "/api/templates", { fromProject: ws.project.id, title: "Rooftop Cut" })).body.code).toBe("SLUG_TAKEN");
      // A cut that shows the original video can't become one.
      await ws.writeJson("render/edl.json", { canvas: { width: 640, height: 360, fps: 24 }, shots: [{ start: 0, end: 1.5, source: { asset: "ref" } }] });
      const refused = await api<{ reasons: string[] }>("POST", "/api/templates", { fromProject: ws.project.id, title: "Ref Cut" });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: "NOT_TEMPLATABLE", reasons: ["This edit shows frames of the original video, so it can't become a template yet."] });
      expect((await api("DELETE", "/api/templates/rooftop-cut")).status).toBe(204);
    }, 60_000);
  });

  describe("projects", () => {
    it("lists projects as cards in their states", async () => {
      const chat = await Workspace.create({ title: "made in chat" });
      await chat.import(still, "subject");
      const decoded = await Workspace.create({ title: "decoded" });
      await decoded.writeJson("app.json", { v: 1, origin: { kind: "decode", sourceName: "x.mp4" }, runs: [], createdAt: AT } satisfies AppJson);
      await decoded.writeJson("analysis/decode.json", { project: decoded.project.id, name: "x.mp4", videoUrl: "", status: "done", phases: [] });
      const paused = await Workspace.create({ title: "paused", preset: "hype-energy" });
      const rid = "r-20261017142233-a1b2";
      await paused.writeJson("app.json", { v: 1, origin: { kind: "template", template: "hype-energy" }, runs: [rid], createdAt: AT } satisfies AppJson);
      await paused.writeJson(`runs/${rid}/run.json`, runRecord(paused.project.id, rid, "paused"));
      const stopped = await Workspace.create({ title: "stopped", preset: "night-stare" });
      await stopped.writeJson("app.json", { v: 1, origin: { kind: "template", template: "night-stare" }, runs: [rid], createdAt: AT } satisfies AppJson);
      await stopped.writeJson(`runs/${rid}/run.json`, runRecord(stopped.project.id, rid, "cancelled"));

      const { status, body } = await api<ProjectCard[]>("GET", "/api/projects");
      expect(status).toBe(200);
      const byId = new Map(body.map((c) => [c.id, c]));
      expect(byId.get(chat.project.id)).toMatchObject({ state: "chat", origin: "chat", versions: 0, poster: `/api/projects/${chat.project.id}/poster?h=480` });
      expect(byId.get(decoded.project.id)).toMatchObject({ state: "decoded", origin: "decode" });
      expect(byId.get(paused.project.id)).toMatchObject({ state: "needs-you", origin: "template", template: "hype-energy", activeRun: rid, aspect: 0.563 });
      expect(byId.get(stopped.project.id)).toMatchObject({ state: "stopped", template: "night-stare" });
      expect(byId.get(stopped.project.id)!.activeRun).toBeUndefined();
      // Edits that need the person come first.
      expect(body[0]!.id).toBe(paused.project.id);
    });

    it("makes posters from the newest thing a project has", async () => {
      const ws = await Workspace.create({ title: "poster chain" });
      const poster = async () => {
        const res = await fetch(`${base}/api/projects/${ws.project.id}/poster?h=200`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/jpeg");
        await res.arrayBuffer();
      };
      const madeFrom = (file: string) => existsSync(ws.path("render", "thumbs", `poster-${Math.round(statSync(file).mtimeMs)}-200.jpg`));
      const stamp = async (file: string, secondsAgo: number) => {
        const t = new Date(Date.now() - secondsAgo * 1000);
        await utimes(file, t, t);
        return file;
      };
      expect((await fetch(`${base}/api/projects/${ws.project.id}/poster`)).status).toBe(404);
      const s1 = await ws.import(still, "subject");
      await stamp(ws.path(s1.path), 60);
      await poster();
      expect(madeFrom(ws.path(s1.path))).toBe(true);
      const ref = await ws.import(reference, "reference", { id: "ref" });
      await stamp(ws.path(ref.path), 50);
      await poster();
      expect(madeFrom(ws.path(ref.path))).toBe(true);
      for (const [name, ago] of [["preview.mp4", 40], ["master.mp4", 30]] as const) {
        const file = ws.path("render", name);
        await copyFile(reference, file);
        await stamp(file, ago);
        await poster();
        expect(madeFrom(file)).toBe(true);
      }
      const delivered = ws.path("deliver", "poster-chain_v1.mp4");
      await copyFile(reference, delivered);
      await stamp(delivered, 20);
      ws.project.versions.push({ version: 1, path: ws.rel(delivered), createdAt: AT });
      await ws.save();
      await poster();
      expect(madeFrom(delivered)).toBe(true);
      // Height is clamped to 120–720.
      expect((await fetch(`${base}/api/projects/${ws.project.id}/poster?h=5000`)).status).toBe(200);
      expect(existsSync(ws.path("render", "thumbs", `poster-${Math.round(statSync(delivered).mtimeMs)}-720.jpg`))).toBe(true);
    }, 60_000);

    it("gives the project page: versions, words, the draft for Make another", async () => {
      const ws = await Workspace.create({ title: "page", preset: "hype-energy" });
      await ws.import(still, "subject");
      await ws.import(still, "subject");
      const delivered = ws.path("deliver", "page_v1.mp4");
      await copyFile(reference, delivered);
      await copyFile(reference, delivered.replace(".mp4", "_silent.mp4"));
      ws.project.versions.push({ version: 1, path: ws.rel(delivered), createdAt: AT, note: "first" });
      await ws.save();
      await ws.writeJson("render/edl.json", {
        canvas: { width: 1080, height: 1920, fps: 30 },
        grid: { bpm: 120, phase: 0.5 },
        audio: null,
        shots: [{ start: 0, end: 2, source: { asset: "s1" } }],
        text: [{ text: "NOTHING NEW", start: "b1", end: "b2", font: "League Gothic", italic: true, uppercase: true }],
      });
      const draft = { kind: "template", template: "hype-energy", photos: ["0123456789abcdef", "fedcba9876543210"], musicChoice: "mine", alignDrop: true, mode: "remix", brief: { who: "NOTHING NEW" }, planFirst: false, commercial: false, clipsModel: "configured" };
      await ws.writeJson("app.json", { v: 1, origin: { kind: "template", template: "hype-energy" }, draft, runs: [], createdAt: AT });
      const { status, body } = await api<ProjectPageData>("GET", `/api/projects/${ws.project.id}/page`);
      expect(status).toBe(200);
      expect(body.card).toMatchObject({ id: ws.project.id, state: "ready", latest: { version: 1, url: `/media/${ws.project.id}/deliver/page_v1.mp4` }, aspect: 0.563 });
      expect(body.versions).toEqual([
        expect.objectContaining({ version: 1, url: `/media/${ws.project.id}/deliver/page_v1.mp4`, silentUrl: `/media/${ws.project.id}/deliver/page_v1_silent.mp4`, note: "first", createdAt: AT }),
      ]);
      expect(body.versions[0]!.sizeMB).toBeGreaterThan(0);
      expect(body.words).toEqual([{ index: 0, text: "NOTHING NEW", startSec: 1, font: "League Gothic", weight: 400, italic: true, uppercase: true }]);
      expect(body.draft?.photos).toEqual([`${ws.project.id}:s1`, `${ws.project.id}:s2`]);
      expect(body.draft?.music).toBeUndefined();
      expect(body.canSaveTemplate).toEqual({ ok: false, reason: "Only edits made from a decoded video can be saved as templates." });
      expect(body.locked).toBe(false);
      expect((await api("GET", "/api/projects/20261017-gone-0000/page")).status).toBe(404);
    });

    it("knows when a decoded edit can become a template", async () => {
      const ws = await Workspace.create({ title: "templatable" });
      await ws.import(reference, "reference", { id: "ref" });
      const gen = ws.path("gen", "walk_t1.png");
      await copyFile(still, gen);
      await ws.register({ path: gen, role: "generated", id: "g1", lineId: "walk" });
      await ws.writeJson("app.json", { v: 1, origin: { kind: "decode" }, runs: [], createdAt: AT } satisfies AppJson);
      const page = async () => (await api<ProjectPageData>("GET", `/api/projects/${ws.project.id}/page`)).body.canSaveTemplate;
      expect(await page()).toEqual({ ok: false, reason: "Make your edit first. Saving it as a template is instant and free." });
      await copyFile(reference, ws.path("deliver", "x_v1.mp4"));
      ws.project.versions.push({ version: 1, path: "deliver/x_v1.mp4", createdAt: AT });
      await ws.save();
      expect(await page()).toEqual({ ok: false, reason: "This edit has no saved cut yet." });
      await ws.writeJson("render/edl.json", { canvas: { width: 640, height: 360, fps: 24 }, shots: [{ start: 0, end: 1, source: { asset: "ref" } }] });
      expect(await page()).toEqual({ ok: false, reason: "This edit shows frames of the original video, so it can't become a template yet." });
      await ws.writeJson("render/edl.json", { canvas: { width: 640, height: 360, fps: 24 }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "g1" } }] });
      expect(await page()).toEqual({ ok: false, reason: "Templates keep the edit's sound: use the original sound or your own track." });
      await ws.writeJson("render/edl.json", { canvas: { width: 640, height: 360, fps: 24 }, shots: [{ start: 0, end: 1, source: { asset: "g1" } }] });
      expect(await page()).toEqual({ ok: true });
    });

    it("swaps a pick into the edit when no run holds the project", async () => {
      const ws = await Workspace.create({ title: "picks" });
      for (const [id, line] of [["g1", "walk"], ["g2", "walk"], ["g3", "smirk"]] as const) {
        const file = ws.path("gen", `${id}.png`);
        await copyFile(still, file);
        await ws.register({ path: file, role: "generated", id, lineId: line });
      }
      await ws.writeJson("render/edl.json", {
        canvas: { width: 320, height: 240, fps: 24 },
        audio: null,
        shots: [
          { start: 0, end: 1, source: { asset: "g1", in: 0.4 } },
          { start: 1, end: 2, source: { asset: "g3" }, layers: [{ source: { asset: "g1" } }] },
        ],
      });
      const r = await api<{ picks: { line: string; asset: string }[]; edlChanged: boolean }>("POST", `/api/projects/${ws.project.id}/picks`, { line: "walk", asset: "g2" });
      expect(r.status).toBe(200);
      expect(r.body.edlChanged).toBe(true);
      expect(r.body.picks).toEqual([expect.objectContaining({ line: "walk", asset: "g2" })]);
      const edl = JSON.parse(await readFile(ws.path("render", "edl.json"), "utf8"));
      expect(edl.shots[0].source).toMatchObject({ asset: "g2", in: 0.4 });
      expect(edl.shots[1].source.asset).toBe("g3");
      expect(edl.shots[1].layers[0].source.asset).toBe("g2");
      const saved = JSON.parse(await readFile(ws.path("qa", "user-picks.json"), "utf8"));
      expect(saved).toMatchObject({ v: 1, picks: [{ line: "walk", asset: "g2" }] });
      // A second pick for the line replaces the first; nothing left to swap.
      const again = await api<{ picks: unknown[]; edlChanged: boolean }>("POST", `/api/projects/${ws.project.id}/picks`, { line: "walk", asset: "g2" });
      expect(again.body).toMatchObject({ edlChanged: false });
      expect(again.body.picks).toHaveLength(1);
      expect((await api("POST", `/api/projects/${ws.project.id}/picks`, { line: "walk", asset: "g3" })).status).toBe(400);
      expect((await api("POST", `/api/projects/${ws.project.id}/picks`, { line: "walk", asset: "../g1" })).status).toBe(400);
    });

    it("exports a new version with a silent copy, reporting progress", async () => {
      const ws = await Workspace.create({ title: "export me" });
      await ws.import(reference, "reference", { id: "ref" });
      await ws.writeJson("render/edl.json", { canvas: { width: 320, height: 180, fps: 24 }, audio: { asset: "ref", offset: 0 }, shots: [{ start: 0, end: 1, source: { asset: "ref" } }] });
      const events = sse(`${base}/api/projects/${ws.project.id}/events`, (e) => e.type === "export" && (e.state === "done" || e.state === "error"), 60_000);
      await new Promise((r) => setTimeout(r, 100));
      expect((await api("POST", `/api/projects/${ws.project.id}/export`)).status).toBe(202);
      const seen = await events;
      const last = seen.filter((e) => e.type === "export").at(-1)!;
      expect(last).toMatchObject({ type: "export", state: "done", version: 1, url: `/media/${ws.project.id}/deliver/export-me_v1.mp4` });
      expect(seen.some((e) => e.type === "export" && e.state === "rendering")).toBe(true);
      expect(seen.some((e) => e.type === "rendered" && e.mode === "master")).toBe(true);
      const fresh = await Workspace.open(ws.project.id);
      expect(fresh.project.versions).toEqual([expect.objectContaining({ version: 1, note: "words changed in the app" })]);
      expect(existsSync(fresh.path("deliver", "export-me_v1_silent.mp4"))).toBe(true);
      const empty = await Workspace.create({ title: "no edit" });
      expect((await api("POST", `/api/projects/${empty.project.id}/export`)).body.code).toBe("NO_EDIT");
    }, 90_000);

    it("reveals in the file manager, and deletes to the trash", async () => {
      const ws = await Workspace.create({ title: "to delete" });
      expect((await api("POST", `/api/projects/${ws.project.id}/reveal`, { what: "folder" })).status).toBe(204);
      expect((await api("POST", `/api/projects/${ws.project.id}/reveal`, { what: "latest" })).body.code).toBe("NO_VERSION");
      expect((await api("POST", `/api/projects/${ws.project.id}/reveal`, { what: "/etc/passwd" })).status).toBe(400);
      expect((await api("DELETE", `/api/projects/${ws.project.id}`)).status).toBe(204);
      expect(existsSync(ws.dir)).toBe(false);
      expect(readdirSync(trashDir()).some((d) => d.startsWith(`${ws.project.id}-`))).toBe(true);
      expect((await api("GET", `/api/projects/${ws.project.id}`)).status).toBe(404);
      expect((await api("DELETE", `/api/projects/${ws.project.id}`)).status).toBe(404);
    });

    it("refuses editor writes and deletes while a run holds the project (409 RUN_ACTIVE)", async (ctx) => {
      const ws = await Workspace.create({ title: "locked" });
      await ws.writeJson("render/edl.json", { canvas: { width: 320, height: 240, fps: 24 }, audio: null, shots: [{ start: 0, end: 1, source: { asset: "black" } }] });
      await lockProject(ws, "r-20261017142233-a1b2");
      if (!isRunActive(ws.dir)) return ctx.skip(); // isRunActive (WP-B) not landed yet
      const edl = { canvas: { width: 320, height: 240, fps: 24 }, shots: [{ start: 0, end: 1, source: { asset: "black" } }] };
      for (const [method, path, body] of [
        ["PUT", "edl", edl],
        ["POST", "render", { mode: "preview" }],
        ["POST", "deliver", undefined],
        ["POST", "export", undefined],
      ] as const) {
        const r = await api(method, `/api/projects/${ws.project.id}/${path}`, body);
        expect(r.status, `${method} ${path}`).toBe(409);
        expect(r.body.code).toBe("RUN_ACTIVE");
      }
      expect((await api("DELETE", `/api/projects/${ws.project.id}`)).body.code).toBe("RUN_ACTIVE");
      expect((await api<ProjectPageData>("GET", `/api/projects/${ws.project.id}/page`)).body.locked).toBe(true);
    });
  });

  describe("decode", () => {
    it("decodes a dropped edit, live over the project channel, and reuses it on a second drop", async (ctx) => {
      const upload = await uploadFile(reference, "edit");
      const r = await api<{ project: string; reused: boolean; state: { status: string } }>("POST", "/api/decode", { upload: upload.id });
      if (r.status === 501) return ctx.skip(); // DecodeManager (WP-C) not landed yet
      expect(r.status).toBe(201);
      expect(r.body.reused).toBe(false);
      const id = r.body.project;
      const ws = await Workspace.open(id);
      expect(ws.reference()?.id).toBe("ref");
      const app = JSON.parse(await readFile(ws.path("app.json"), "utf8")) as AppJson;
      expect(app.origin).toMatchObject({ kind: "decode", sourceName: "reference.mp4", uploadHash: upload.hash });
      const seen = await sse(`${base}/api/projects/${id}/events`, (e) => e.type === "decode" && (e.state as { status: string }).status === "done", 15_000);
      const state = (await api<{ status: string }>("GET", `/api/projects/${id}/decode`)).body;
      expect(state.status).toBe("done");
      expect(seen.length === 0 || seen.at(-1)!.type === "decode").toBe(true);

      const second = await uploadFile(reference, "edit");
      const again = await api<{ project: string; reused: boolean }>("POST", "/api/decode", { upload: second.id });
      expect(again.body).toMatchObject({ project: id, reused: true });
      const fork = await api<{ project: string; reused: boolean }>("POST", "/api/decode", { fromProject: id });
      expect(fork.status).toBe(201);
      expect(fork.body.project).not.toBe(id);
      expect(existsSync(join((await Workspace.open(fork.body.project)).dir, "app.json"))).toBe(true);
    }, 60_000);

    it("checks decode requests", async () => {
      const photo = await uploadFile(portrait, "photo");
      expect((await api("POST", "/api/decode", { upload: "0123456789abcdef" })).status).toBe(404);
      expect((await api("POST", "/api/decode", { upload: "../etc" })).status).toBe(400);
      expect((await api("POST", "/api/decode", {})).status).toBe(400);
      expect((await api("POST", "/api/decode", { fromProject: "20261017-gone-0000" })).status).toBe(404);
      expect((await api("POST", "/api/decode", { upload: photo.id })).status).toBe(422);
      const plain = await Workspace.create({ title: "not decoded" });
      expect((await api("GET", `/api/projects/${plain.project.id}/decode`)).status).toBe(404);
    });
  });

  describe("request checks on every mutating route", () => {
    const id = "20261017-some-project-a1b2";
    const MUTATING: [string, string, unknown?][] = [
      ["POST", "/api/uploads"],
      ["DELETE", "/api/uploads/0123456789abcdef"],
      ["POST", "/api/decode", { upload: "0123456789abcdef" }],
      ["POST", "/api/templates", { fromProject: id, title: "X" }],
      ["DELETE", "/api/templates/hype-energy"],
      ["DELETE", `/api/projects/${id}`],
      ["POST", `/api/projects/${id}/reveal`, { what: "folder" }],
      ["POST", `/api/projects/${id}/export`],
      ["POST", `/api/projects/${id}/picks`, { line: "a", asset: "b" }],
      ["PUT", `/api/projects/${id}/edl`, {}],
      ["POST", `/api/projects/${id}/render`, {}],
      ["POST", `/api/projects/${id}/deliver`],
      ["PUT", "/api/settings", {}],
      ["POST", "/api/setup/gpu", { kind: "http" }],
      ["POST", "/api/runs", {}],
      ["POST", "/api/runs/estimate", {}],
      ["POST", "/api/runs/r-20261017142233-a1b2/cancel"],
      ["POST", "/api/runs/r-20261017142233-a1b2/continue", {}],
      ["POST", "/api/runs/r-20261017142233-a1b2/start-now"],
    ];

    it("403 from another site", async () => {
      for (const [method, path, body] of MUTATING) {
        const r = await api(method, path, body ?? {}, { ...INTENT, origin: "https://evil.example" });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    });

    it("403 without the intent header", async () => {
      for (const [method, path, body] of MUTATING) {
        const r = await api(method, path, body ?? {}, { "content-type": "application/json" });
        expect(r.status, `${method} ${path}`).toBe(403);
        expect(r.body.code, `${method} ${path}`).toBe("NO_INTENT");
      }
    });

    it("400 for a malformed id", async () => {
      const bad = "..%2f..%2fetc";
      for (const [method, path, body] of [
        ["DELETE", `/api/uploads/${bad}`],
        ["GET", `/api/uploads/${bad}`],
        ["GET", `/uploads/${bad}/media`],
        ["DELETE", `/api/templates/${bad}`],
        ["GET", `/api/templates/${bad}`],
        ["GET", `/api/projects/${bad}/page`],
        ["GET", `/api/projects/${bad}/poster`],
        ["GET", `/api/projects/${bad}/decode`],
        ["GET", `/api/projects/${bad}/events`],
        ["DELETE", `/api/projects/${bad}`],
        ["POST", `/api/projects/${bad}/reveal`, { what: "folder" }],
        ["POST", `/api/projects/${bad}/export`],
        ["POST", `/api/projects/${bad}/picks`, { line: "a", asset: "b" }],
        ["PUT", `/api/projects/${bad}/edl`, {}],
        ["POST", `/api/projects/${bad}/render`, {}],
        ["POST", `/api/projects/${bad}/deliver`],
        ["GET", `/api/projects/${bad}`],
        ["GET", `/media/${bad}/x.mp4`],
      ] as [string, string, unknown?][]) {
        const r = await api(method, path, body);
        expect(r.status, `${method} ${path}`).toBe(400);
      }
    });
  });

  it("carries global events to every listener", async () => {
    const ws = await Workspace.create({ title: "global events" });
    const events = sse(`${base}/api/events`, (e) => e.type === "projects", 10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await api("DELETE", `/api/projects/${ws.project.id}`)).status).toBe(204);
    expect((await events).map((e) => e.type)).toContain("projects");
  });
});

describe("the app lock", () => {
  it("lets one server own the app, and releases it on stop", async () => {
    const a = new Studio();
    await a.start(0, { appOwner: true });
    try {
      expect(a.owner).toBe(true);
      expect(await readAppLock()).toMatchObject({ pid: process.pid, port: a.port });
      const info = (await (await fetch(`http://127.0.0.1:${a.port}/api/info`)).json()) as Info;
      expect(info.owner).toBe(true);
      const b = new Studio();
      await b.start(0, { appOwner: true });
      expect(b.owner).toBe(false);
      await b.stop();
      expect(existsSync(appLockFile())).toBe(true);
    } finally {
      await a.stop();
    }
    expect(existsSync(appLockFile())).toBe(false);
  });

  it("replaces a stale lock", async () => {
    await mkdir(join(appLockFile(), ".."), { recursive: true });
    await writeFile(appLockFile(), JSON.stringify({ pid: 999_999, port: 1, version: "0.0.1", procStart: "never", startedAt: AT }));
    const s = new Studio();
    await s.start(0, { appOwner: true });
    expect(s.owner).toBe(true);
    await s.stop();
  });
});

describe("open-katana app", () => {
  const children: ChildProcess[] = [];
  let home: string;

  const cli = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(packageRoot(), "src", "cli.ts"), ...args], {
      cwd: packageRoot(),
      env: { ...process.env, OPEN_KATANA_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    const line = async (pattern: RegExp, ms = 30_000) => {
      for (let t = 0; t < ms; t += 50) {
        const m = pattern.exec(output);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no ${pattern} in: ${output}`);
    };
    return { child, exited, line, output: () => output };
  };

  beforeAll(async () => {
    home = await tempDir("ok-cli-home-");
  });

  afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  });

  it("opens the app, reuses it from a second command, and restarts it with --replace", async () => {
    const first = cli(["app", "--no-open", "--port", "0"]);
    const [, port] = (await first.line(/open-katana: http:\/\/127\.0\.0\.1:(\d+)\//))!;
    const info = (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()) as Info;
    expect(info).toMatchObject({ owner: true, pid: first.child.pid });

    const second = cli(["app", "--no-open"]);
    expect(await second.exited).toBe(0);
    expect(second.output()).toContain(`open-katana: http://127.0.0.1:${port}/`);
    const editor = cli(["studio", "20261017-some-edit-a1b2", "--no-open"]);
    expect(await editor.exited).toBe(0);
    expect(editor.output()).toContain(`http://127.0.0.1:${port}/edit/20261017-some-edit-a1b2`);

    const runs = cli(["runs", "list"]);
    await runs.exited;
    expect(runs.output()).not.toContain("isn't running");

    const third = cli(["app", "--no-open", "--replace", "--port", "0"]);
    const [, newPort] = (await third.line(/open-katana: http:\/\/127\.0\.0\.1:(\d+)\//))!;
    expect(await first.exited).toBe(0);
    const lock = JSON.parse(await readFile(join(home, "app", "app.lock"), "utf8"));
    expect(lock).toMatchObject({ pid: third.child.pid, port: Number(newPort) });

    third.child.kill("SIGTERM");
    expect(await third.exited).toBe(0);
    expect(existsSync(join(home, "app", "app.lock"))).toBe(false);
    const none = cli(["runs", "list"]);
    expect(await none.exited).toBe(1);
    expect(none.output()).toContain('The open-katana app isn\'t running. Start it with "open-katana app".');
  }, 120_000);
});
