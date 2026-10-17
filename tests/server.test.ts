import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageCode } from "../src/engine/sheets.js";
import { run } from "../src/util/proc.js";
import { makeReferenceEdit, tempDir } from "./helpers/synth.js";

type ToolResult = { content: { type: string; text?: string; data?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

describe("MCP server: the free path from reference to delivery", () => {
  let client: Client;
  let home: string;
  let reference: string;
  let photo: string;
  let project: string;

  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

  beforeAll(async () => {
    home = await tempDir("ok-home-");
    const media = await tempDir("ok-media-");
    reference = await makeReferenceEdit(media);
    photo = join(media, "hero.png");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=768x1024", "-frames:v", "1", photo]);
    client = new Client({ name: "open-katana-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "mcp"],
        env: { ...getDefaultEnvironment(), OPEN_KATANA_HOME: home, OPEN_KATANA_BACKEND: "http", COMFYUI_URL: "http://127.0.0.1:9" },
        stderr: "ignore",
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it("reports the package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("lists the katana tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["katana_guide", "katana_presets", "katana_start", "katana_analyze", "katana_view", "katana_review", "katana_plan", "katana_generate", "katana_wait", "katana_judge", "katana_edit", "katana_render", "katana_deliver", "katana_backend", "katana_status", "katana_cancel"]) {
      expect(names).toContain(n);
    }
  });

  it("serves the workflow guide and the built-in presets", async () => {
    expect(textOf(await call("katana_guide", {}))).toContain("Read the reference completely");
    const presets = await call("katana_presets", {});
    expect(textOf(presets)).toContain("/katana/neon-rain");
  });

  it("starts a project with a reference and a subject", async () => {
    const r = await call("katana_start", { reference, subjects: [photo], preset: "neon-rain", title: "test aura" });
    expect(r.isError).toBeFalsy();
    project = r.structuredContent!.project as string;
    expect(project).toMatch(/test-aura/);
  });

  it("analyzes the reference and returns the overview image", async () => {
    const r = await call("katana_analyze", { project });
    expect(r.isError).toBeFalsy();
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    expect(r.structuredContent!.pages).toBe(4);
  });

  it("refuses generation before the review is complete", async () => {
    const r = await call("katana_generate", { project, approved: true, jobs: [{ line: "k1", operation: "still.compose", prompt: "x", images: ["s1"] }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/review pages/);
  });

  it("shows review pages and only accepts their real check codes", async () => {
    const view = await call("katana_view", { project, target: "page", pages: [1, 2] });
    expect(view.content.filter((c) => c.type === "image")).toHaveLength(2);
    const bad = await call("katana_review", { project, pages: [{ page: 1, code: "ZZZZ" }] });
    expect(textOf(bad)).toMatch(/did not match/);
    const pages = [1, 2, 3, 4].map((page) => ({ page, code: pageCode(project, page) }));
    const ok = await call("katana_review", { project, pages, notes: "s0 pan right; s2 insert; flash at 1.96 s" });
    expect(textOf(ok)).toContain("Review complete");
  });

  it("plans, edits, renders and delivers without generation", async () => {
    const plan = await call("katana_plan", {
      project,
      plan: { concept: "Hero still with reference energy", shots: [{ at: "0-3.5", role: "identity", description: "hero still with punches", route: "still" }], jobs: [] },
    });
    expect(plan.isError).toBeFalsy();
    const edl = {
      canvas: { width: 640, height: 360, fps: 24 },
      shots: [
        { start: 0, end: 1, source: { asset: "ref", in: 0 } },
        { start: 1, end: 2.5, source: { asset: "s1" }, camera: { zoom: [1, 1.2], punch: { at: ["b2"] } }, fx: { look: "teal-night", flashIn: 0.1 } },
        { start: 2.5, end: 3.5, source: { asset: "ref", in: 2.5 }, camera: { shake: {} } },
      ],
      flashes: [{ at: 1 }],
      text: [{ text: "AURA", start: 1, end: 2.5, anim: "slam", size: 0.2 }],
    };
    const edit = await call("katana_edit", { project, edl });
    expect(edit.isError).toBeFalsy();
    expect(edit.structuredContent!.frames).toBe(84);
    const preview = await call("katana_render", { project, preview: true });
    expect(preview.isError).toBeFalsy();
    expect(preview.content.some((c) => c.type === "image")).toBe(true);
    const final = await call("katana_render", { project, preview: false });
    expect(final.structuredContent!.frames).toBe(84);
    expect(final.structuredContent!.issues).toEqual([]);
    const pages = await call("katana_view", { project, target: "render-pages", pages: [1, 4] });
    expect(pages.content.filter((c) => c.type === "image")).toHaveLength(2);
    const delivered = await call("katana_deliver", { project });
    expect(delivered.isError).toBeFalsy();
    expect(existsSync(delivered.structuredContent!.path as string)).toBe(true);
    const media = await client.readResource({ uri: delivered.structuredContent!.uri as string });
    expect((media.contents[0] as { blob?: string }).blob?.length).toBeGreaterThan(1000);
  }, 180_000);

  it("builds an edit from a preset skeleton", async () => {
    const r = await call("katana_start", { reference, subjects: [photo], preset: "night-stare", title: "skeleton test" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Edit skeleton:");
    const id = r.structuredContent!.project as string;
    const { readFile } = await import("node:fs/promises");
    const preset = JSON.parse(await readFile(join(process.cwd(), "presets/night-stare/preset.json"), "utf8")) as { slots: { id: string }[] };
    const missing = await call("katana_edit", { project: id, fromPreset: { slots: {} } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Missing:");
    const slots = Object.fromEntries(preset.slots.map((sl) => [sl.id, "s1"]));
    const edit = await call("katana_edit", { project: id, fromPreset: { slots } });
    expect(edit.isError).toBeFalsy();
    expect(textOf(edit)).toContain("Built from the preset skeleton");
    expect(textOf(edit)).not.toContain('"slot:');
  }, 120_000);

  const slotsOf = async (slug: string) => {
    const { readFile } = await import("node:fs/promises");
    const preset = JSON.parse(await readFile(join(process.cwd(), `presets/${slug}/preset.json`), "utf8")) as { slots: { id: string }[] };
    return Object.fromEntries(preset.slots.map((sl) => [sl.id, "s1"]));
  };
  const savedEdl = async (id: string) => JSON.parse(readFileSync(join(home, "projects", id, "render", "edl.json"), "utf8")) as { audio?: { asset: string; offset: number }; grid?: { bpm: number; phase: number }; canvas: { durationSec?: number } };

  it("a preset without a reference or music uses its own track, so the skeleton's edit has sound", async () => {
    const r = await call("katana_start", { subjects: [photo], preset: "hype-energy", title: "own track" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("is imported as asset music");
    const assets = r.structuredContent!.assets as { id: string; role: string }[];
    expect(assets.find((x) => x.id === "music")).toMatchObject({ role: "audio" });
    const id = r.structuredContent!.project as string;
    const edit = await call("katana_edit", { project: id, fromPreset: { slots: await slotsOf("hype-energy") } });
    expect(edit.isError, textOf(edit)).toBeFalsy();
    const edl = await savedEdl(id);
    expect(edl.audio).toMatchObject({ asset: "music", offset: 0 });
    // The template's own track keeps the skeleton's grid.
    expect(edl.grid).toEqual({ bpm: 144, phase: 0.5 });
    // Audio "ref" in a project without a reference is refused at once, not at render.
    const bad = await call("katana_edit", { project: id, edl: { canvas: { width: 1080, height: 1920, fps: 30 }, audio: { asset: "ref" }, shots: [{ start: 0, end: 1, source: { asset: "black" } }] } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('no reference video, so audio "ref" has no sound');
  }, 120_000);

  it("a skeleton played on the user's own music is retimed to its beat", async () => {
    const media = await tempDir("ok-music-");
    const track = join(media, "ninety.wav");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=30", "-af", "volume='if(lt(mod(t,0.6666667),0.03),1,0)':eval=frame", track]);
    const r = await call("katana_start", { subjects: [photo], preset: "night-stare", music: track, title: "my track" });
    expect(textOf(r)).not.toContain("is imported as asset music");
    const id = r.structuredContent!.project as string;
    const edit = await call("katana_edit", { project: id, fromPreset: { slots: await slotsOf("night-stare") } });
    expect(edit.isError, textOf(edit)).toBeFalsy();
    expect(textOf(edit)).toContain("Retimed to the music");
    const edl = await savedEdl(id);
    expect(edl.audio?.asset).toBe("music");
    expect(edl.grid!.bpm).toBeGreaterThan(88);
    expect(edl.grid!.bpm).toBeLessThan(92);
  }, 120_000);
});
