import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace } from "../src/project/workspace.js";
import { textToAss } from "../src/render/ass.js";
import { type Edl, EdlSchema, TextSchema } from "../src/render/edl.js";
import { Studio } from "../src/studio/server.js";
import { run } from "../src/util/proc.js";
import { addText, applyStyleToAll, moveShotEdge, shotAt, splitShot, stackRows } from "../studio/src/edits.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

const ctx = { fps: 24, beats: [0.5, 1, 1.5, 2, 2.5, 3] };
/** Every request that changes something carries the intent header and is sent as JSON. */
const INTENT = { "x-katana": "1", "content-type": "application/json" };

const edl = (): Edl =>
  EdlSchema.parse({
    canvas: { width: 640, height: 360, fps: 24 },
    shots: [
      { id: "a", start: 0, end: "b1", source: { asset: "clip1", in: 1, speed: 1 } },
      { id: "b", start: "b1", end: 2, source: { asset: "clip2", in: 0.5, speed: 0.5 }, camera: { zoom: [1, 1.2], ease: "linear" }, fx: { flashIn: 0.1, dipOut: 0.2 } },
    ],
    text: [{ text: "ONE", start: 0.2, end: 0.8, font: "Anton", size: 0.1, anim: "slam", color: "#FF0000" }],
  });

describe("studio edit operations", () => {
  it("rolls a shared cut and keeps the incoming shot's content anchored", () => {
    const e = edl();
    expect(moveShotEdge(e, 0, "end", "b2", ctx)).toBe(true);
    expect(e.shots[0]!.end).toBe("b2");
    expect(e.shots[1]!.start).toBe("b2");
    // The cut moved 0.5 s later; at half speed the next shot now starts 0.25 s further into its clip.
    expect(e.shots[1]!.source.in).toBeCloseTo(0.75, 6);
    expect(e.shots[0]!.source.in).toBe(1);
  });

  it("stops a trim one frame short of swallowing the neighbour", () => {
    const e = edl();
    expect(moveShotEdge(e, 1, "start", 5, ctx)).toBe(true);
    expect(e.shots[1]!.start).toBeCloseTo(2 - 1 / 24, 4);
    expect(e.shots[0]!.end).toBe(e.shots[1]!.start);
  });

  it("splits a shot so the halves continue the clip, the zoom and the edge effects", () => {
    const e = edl();
    expect(splitShot(e, 1, 1.5, ctx)).toBe(2);
    const [, first, second] = e.shots;
    expect(first!.end).toBe(1.5);
    expect(second!.start).toBe(1.5);
    expect(second!.id).toBe("b-b");
    expect(second!.source.in).toBeCloseTo(0.5 + 0.5 * 0.5, 6);
    expect(first!.camera!.zoom).toEqual([1, 1.1]);
    expect(second!.camera!.zoom).toEqual([1.1, 1.2]);
    expect(first!.fx).toEqual({ flashIn: 0.1 });
    expect(second!.fx).toEqual({ dipOut: 0.2 });
    expect(splitShot(e, 0, 0, ctx)).toBeNull();
  });

  it("finds the visible shot and adds text styled like its neighbour", () => {
    const e = edl();
    expect(shotAt(e, 0.99, ctx)).toBe(0);
    expect(shotAt(e, 1, ctx)).toBe(1);
    expect(shotAt(e, 2.5, ctx)).toBe(-1);
    const i = addText(e, "b2", ctx);
    expect(e.text[i]).toMatchObject({ start: "b2", end: "b4", font: "Anton", anim: "slam", color: "#FF0000", behind: false });
    e.text[i]!.font = "Cinzel";
    applyStyleToAll(e, i);
    expect(e.text.every((t) => t.font === "Cinzel")).toBe(true);
    expect(EdlSchema.safeParse(e).success).toBe(true);
  });

  it("stacks overlapping text into rows", () => {
    expect(stackRows([{ a: 0, b: 1 }, { a: 0.5, b: 2 }, { a: 1, b: 3 }])).toEqual({ rows: [0, 1, 0], count: 2 });
  });
});

describe("text sizing", () => {
  it("sizes text by its real cap height when font metrics are known", () => {
    const t = TextSchema.parse({ text: "X", start: 0, end: 1, size: 0.1 });
    const fs = (ass: string) => Number(/\\fs(\d+)/.exec(ass)![1]);
    expect(fs(textToAss([{ event: t, startSec: 0, endSec: 1 }], 1920, 1080))).toBe(Math.round(108 / 0.7));
    expect(fs(textToAss([{ event: t, startSec: 0, endSec: 1 }], 1920, 1080, () => 0.5))).toBe(216);
  });
});

describe("studio server", () => {
  let studio: Studio;
  let base: string;
  let ws: Workspace;

  beforeAll(async () => {
    const media = await tempDir("ok-studio-");
    const reference = await makeReferenceEdit(media);
    const still = join(media, "still.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", still]);
    ws = await Workspace.create({ title: "studio test" });
    await ws.import(reference, "reference");
    await ws.import(still, "style", { id: "still1" });
    studio = new Studio();
    await studio.start(0);
    base = `http://127.0.0.1:${studio.port}`;
  }, 120_000);

  afterAll(async () => {
    await studio?.stop();
  });

  it("lists projects and serves a project's state", async () => {
    const list = (await (await fetch(`${base}/api/projects`)).json()) as { id: string }[];
    expect(list.map((p) => p.id)).toContain(ws.project.id);
    const state = (await (await fetch(`${base}/api/projects/${ws.project.id}`)).json()) as { assets: { id: string; url: string }[]; edl?: unknown };
    expect(state.edl).toBeUndefined();
    expect(state.assets.find((a) => a.id === "still1")?.url).toMatch(/^\/media\//);
  });

  it("validates and saves edits", async () => {
    const put = (body: unknown) => fetch(`${base}/api/projects/${ws.project.id}/edl`, { method: "PUT", headers: INTENT, body: JSON.stringify(body) });
    const bad = await put({ canvas: { width: 10, height: 10, fps: 24 }, shots: [] });
    expect(bad.status).toBe(400);
    const good = await put({ canvas: { width: 320, height: 240, fps: 24 }, shots: [{ start: 0, end: 1, source: { asset: "still1" } }], text: [{ text: "HI", start: 0, end: 1 }] });
    expect(good.status).toBe(200);
    const saved = JSON.parse(await readFile(ws.path("render", "edl.json"), "utf8")) as Edl;
    expect(saved.text[0]!.font).toBe("Anton");
  });

  it("serves thumbnails, waveforms and byte ranges", async () => {
    const thumb = await fetch(`${base}/api/projects/${ws.project.id}/thumb?asset=ref&t=1&h=48`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    const wave = (await (await fetch(`${base}/api/projects/${ws.project.id}/waveform?asset=ref`)).json()) as { perSec: number; peaks: number[] };
    expect(wave.perSec).toBe(100);
    expect(wave.peaks.some((p) => p > 0.05)).toBe(true);
    const ref = ws.asset("ref");
    const part = await fetch(`${base}/media/${ws.project.id}/${ref.path}`, { headers: { range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expect((await fetch(`${base}/media/${ws.project.id}/..%2f..%2f..%2fproject.json`)).status).toBe(400);
    // Other sites can't drive the local editor.
    const foreign = await fetch(`${base}/api/projects/${ws.project.id}/render`, { method: "POST", headers: { ...INTENT, origin: "https://example.com" }, body: "{}" });
    expect(foreign.status).toBe(403);
    // Nor can a page that doesn't send the intent header.
    const unmarked = await fetch(`${base}/api/projects/${ws.project.id}/render`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unmarked.status).toBe(403);
  });

  it("renders the picture-only preview on request", async () => {
    const events: string[] = [];
    const res = await fetch(`${base}/api/projects/${ws.project.id}/events`);
    const reader = res.body!.getReader();
    const done = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        const text = dec.decode(value);
        events.push(text);
        if (text.includes('"rendered"') || text.includes("render-error")) return;
      }
    })();
    expect((await fetch(`${base}/api/projects/${ws.project.id}/render`, { method: "POST", headers: INTENT, body: JSON.stringify({ mode: "notext" }) })).status).toBe(202);
    await done;
    await reader.cancel();
    expect(events.join("")).toContain('"rendered"');
    expect(existsSync(ws.path("render", "preview-notext.mp4"))).toBe(true);
    expect(existsSync(ws.path("render", "preview-notext.mp4.partial.mp4"))).toBe(false);
  }, 120_000);
});
