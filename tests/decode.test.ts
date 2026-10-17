import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { DecodeManager } from "../src/app/decode.js";
import type { DecodePhase, DecodeState } from "../src/app/types.js";
import { pageCode } from "../src/engine/sheets.js";
import { analyzeProject, type StoredPage } from "../src/project/analysis.js";
import { Workspace } from "../src/project/workspace.js";
import { createServer } from "../src/server/server.js";
import { makeReferenceEdit, tempDir, TRUTH } from "./helpers/synth.js";

describe("decoding a dropped edit", () => {
  let ws: Workspace;
  let states: DecodeState[];
  let first: DecodeState;
  let manager: DecodeManager;

  beforeAll(async () => {
    const ref = await makeReferenceEdit(await tempDir("ok-decode-"));
    ws = await Workspace.create({ title: "my fav edit" });
    await ws.import(ref, "reference", { id: "ref" });
    states = [];
    manager = new DecodeManager({ emit: (project, state) => project === ws.project.id && states.push(state) });
    first = await manager.start(ws, "my-fav-edit.mp4");
    await manager.settled(ws.project.id);
  }, 120_000);

  const doneAt = (id: DecodePhase) => states.findIndex((s) => s.phases.find((p) => p.id === id)?.state === "done");
  const final = () => states.at(-1)!;

  it("answers at once with a running state, then reports every phase in order", () => {
    expect(first.status).toBe("running");
    expect(first.name).toBe("my-fav-edit.mp4");
    expect(first.videoUrl).toMatch(new RegExp(`^/media/${ws.project.id}/media/ref-[0-9a-f]+\\.mp4$`));
    expect(first.phases.map((p) => p.id)).toEqual(["upload", "probe", "frames", "cuts", "motion", "audio", "energy", "palette", "pages", "overview"]);
    const order = (["probe", "frames", "cuts", "motion", "audio", "energy", "pages", "overview"] as const).map(doneAt);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
    expect(doneAt("palette")).toBe(doneAt("cuts"));
    const frames = states.filter((s) => s.phases.find((p) => p.id === "frames")?.state === "now").at(-1)?.phases.find((p) => p.id === "frames");
    expect(frames?.total).toBe(TRUTH.frameCount);
    expect(final().status).toBe("done");
    expect(final().phases.every((p) => p.state === "done")).toBe(true);
  });

  it("is ready, with stats, the read and the Cut Map, before the review pages are made", () => {
    const ready = states.findIndex((s) => s.status === "ready");
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(doneAt("pages"));
    const s = states[ready]!;
    expect(s.phases.find((p) => p.id === "pages")?.state).toBe("now");
    expect(s.tookMs).toBeGreaterThan(0);
    expect(s.format).toMatchObject({ width: 640, height: 360, hasAudio: true });
    expect(s.format!.fps).toBeCloseTo(24, 1);
    expect(s.stats!.shots).toBe(TRUTH.cutFrames.length + 1);
    expect(s.stats!.cuts).toBe(TRUTH.cutFrames.length);
    expect(s.stats!.bpm).toBeGreaterThan(115);
    expect(s.stats!.bpm).toBeLessThan(125);
    expect(s.read!.length).toBeGreaterThan(0);
    expect(s.read![0]).toMatch(/^(Very fast|Fast and punchy|Steady|Slow and moody)\.$/);
    // Lanes arrive one by one: shots before the beats, then the whole map.
    const firstMap = states.find((x) => x.cutMap)!;
    expect(firstMap.cutMap!.shots).toHaveLength(TRUTH.cutFrames.length + 1);
    expect(firstMap.cutMap!.beats).toEqual([]);
    expect(s.cutMap!.beats.length).toBeGreaterThan(4);
    expect(s.cutMap!.energy).toHaveLength(4);
  });

  it("gives every shot one colour and a thumbnail at its middle", () => {
    const s = final();
    expect(s.shots).toHaveLength(TRUTH.cutFrames.length + 1);
    expect(s.cutMap!.shots.map((x) => x.color)).toEqual(s.shots!.map((x) => x.color));
    for (const shot of s.shots!) {
      expect(shot.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(shot.thumb).toBe(`/api/projects/${ws.project.id}/thumb?asset=ref&t=${((shot.start + shot.end) / 2).toFixed(2)}&h=120`);
    }
    // The insert is a blue frame; the bars are not.
    expect(s.shots![2]!.color).toMatch(/^#[0-3][0-9a-f][0-5][0-9a-f][c-f][0-9a-f]$/);
    expect(s.cutMap!.flashes.some((f) => Math.abs(f.t - TRUTH.flashFrames[0]! / 24) < 0.05)).toBe(true);
  });

  it("stores the review pages with hashed codes, sets the stage and keeps the final state", async () => {
    const fresh = await Workspace.open(ws.project.id);
    const pages = (await fresh.readJson<StoredPage[]>("analysis/pages.json"))!;
    expect(pages).toHaveLength(Math.ceil(TRUTH.frameCount / 24));
    expect(final().pages).toBe(pages.length);
    for (const p of pages) {
      expect(p).not.toHaveProperty("code");
      expect(p.codeHash).toBe(createHash("sha256").update(`${ws.project.id}:${pageCode(ws.project.id, p.page)}`).digest("hex"));
    }
    expect(fresh.project.stage).toBe("analyzed");
    expect(fresh.project.reviewedPages).toEqual({});
    const saved = await fresh.readJson<DecodeState>("analysis/decode.json");
    expect(saved).toEqual(final());
    expect(await manager.get(fresh)).toEqual(final());
    // Starting again returns the saved decode instead of decoding twice.
    expect(await manager.start(fresh, "again.mp4")).toEqual(final());
  });

  it("leaves nothing for katana_analyze to redo", async () => {
    const before = statSync(ws.path("analysis", "breakdown.json")).mtimeMs;
    expect(await analyzeProject(await Workspace.open(ws.project.id))).toEqual({ reused: true, pages: Math.ceil(TRUTH.frameCount / 24) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverSide);
    const client = new Client({ name: "decode-test", version: "0" });
    await client.connect(clientSide);
    const r = (await client.callTool({ name: "katana_analyze", arguments: { project: ws.project.id } })) as { isError?: boolean; structuredContent?: { pages: number; shots: unknown[] } };
    await client.close();
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.pages).toBe(Math.ceil(TRUTH.frameCount / 24));
    expect(r.structuredContent!.shots).toHaveLength(TRUTH.cutFrames.length + 1);
    expect(statSync(ws.path("analysis", "breakdown.json")).mtimeMs).toBe(before);
  });

  it("reports a project without a picture as an error, and tries again on the next start", async () => {
    const empty = await Workspace.create({ title: "no video" });
    const errors: DecodeState[] = [];
    const m = new DecodeManager({ emit: (_p, s) => errors.push(s) });
    await m.start(empty, "song.mp3");
    await m.settled(empty.project.id);
    expect(errors.at(-1)).toMatchObject({ status: "error", error: { code: "NO_VIDEO_STREAM", message: "We couldn't find any picture in that file." } });
    expect((await m.get(empty))?.status).toBe("error");
    const again = await m.start(empty, "song.mp3");
    expect(again.status).toBe("running");
    await m.settled(empty.project.id);
  });
});
