import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertId, isId, safeJoin } from "../src/app/http.js";
import { HttpError } from "../src/app/router.js";
import { Workspace } from "../src/project/workspace.js";
import { fontsDir } from "../src/render/fonts.js";
import { Studio } from "../src/studio/server.js";
import { dataHome } from "../src/util/paths.js";
import { tempDir } from "./helpers/synth.js";

/** The HTTP status safeJoin answers with, or "ok" when it accepts the path. */
function verdict(root: string, rel: string): number | "ok" {
  try {
    safeJoin(root, rel);
    return "ok";
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

describe("safeJoin", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await tempDir("ok-safejoin-");
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(join(root, "media"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "media", "a.mp4"), "x");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await symlink(join(outside, "secret.txt"), join(root, "media", "link.txt"));
  });

  it("joins plain and encoded names inside the root", () => {
    expect(safeJoin(root, "media/a.mp4").endsWith(join("root", "media", "a.mp4"))).toBe(true);
    expect(safeJoin(root, "media%2Fa.mp4").endsWith(join("root", "media", "a.mp4"))).toBe(true);
    // Not there yet is fine: the caller answers 404.
    expect(verdict(root, "media/missing.mp4")).toBe("ok");
  });

  it("refuses ../ escapes, encoded or not", () => {
    expect(verdict(root, "../outside/secret.txt")).toBe(400);
    expect(verdict(root, "..%2foutside%2fsecret.txt")).toBe(400);
    expect(verdict(root, "..%2Foutside%2Fsecret.txt")).toBe(400);
    expect(verdict(root, "media/..%2f..%2foutside/secret.txt")).toBe(400);
    expect(verdict(root, "..")).toBe(400);
    expect(verdict(root, "")).toBe(400);
  });

  it("refuses backslashes (%5c), absolute paths and null bytes", () => {
    expect(verdict(root, "..%5coutside%5csecret.txt")).toBe(400);
    expect(verdict(root, "media\\a.mp4")).toBe(400);
    expect(verdict(root, "/etc/passwd")).toBe(400);
    expect(verdict(root, "%2Fetc%2Fpasswd")).toBe(400);
    expect(verdict(root, "C:%5CWindows")).toBe(400);
    expect(verdict(root, "media/a.mp4%00.png")).toBe(400);
    expect(verdict(root, "media/%zz")).toBe(400);
  });

  it("refuses symlinks that lead out of the root", () => {
    expect(verdict(root, "escape/secret.txt")).toBe(400);
    expect(verdict(root, "media/link.txt")).toBe(400);
  });
});

describe("id validators", () => {
  it("accepts the id formats of spec §8.3", () => {
    expect(isId("project", "20261017-hype-energy-a1b2")).toBe(true);
    expect(isId("run", "r-20261017214700-0f3a")).toBe(true);
    expect(isId("upload", "0123456789abcdef")).toBe(true);
    expect(isId("asset", "c_walk_t2")).toBe(true);
    expect(isId("slug", "hype-energy")).toBe(true);
    expect(isId("line", "temple-key")).toBe(true);
  });

  it("refuses separators, traversal, encodings and over-long ids", () => {
    for (const bad of ["../20261017-x-a1b2", "20261017-x-a1b2/..", "/tmp/x", "%2Ftmp%2Fx", "20261017-x-a1b2\0", "20261017-X-a1b2", "", `20261017-${"a".repeat(100)}-a1b2`]) {
      expect(isId("project", bad)).toBe(false);
    }
    expect(isId("upload", "0123456789ABCDEF")).toBe(false);
    expect(isId("upload", "../0123456789abc")).toBe(false);
    expect(isId("asset", "a/b")).toBe(false);
    expect(isId("asset", "a".repeat(65))).toBe(false);
    expect(isId("slug", "Hype")).toBe(false);
    expect(isId("slug", "a".repeat(65))).toBe(false);
    expect(isId("line", "a b")).toBe(false);
    expect(isId("run", "r-2026-0f3a")).toBe(false);
    expect(isId("project", 42)).toBe(false);
    expect(() => assertId("project", "../x")).toThrow(HttpError);
  });
});

describe("server paths", () => {
  let studio: Studio;
  let base: string;
  let ws: Workspace;

  beforeAll(async () => {
    ws = await Workspace.create({ title: "security test" });
    await mkdir(ws.path("runs", "r-20261017000000-0a0a"), { recursive: true });
    await writeFile(ws.path("runs", "r-20261017000000-0a0a", "run.json"), "{}");
    await writeFile(ws.path("app.json"), "{}");
    await writeFile(ws.path("render", "ok.txt"), "fine");
    // A sibling of the fonts folder whose name starts the same way.
    await mkdir(fontsDir(), { recursive: true });
    await mkdir(join(dataHome(), "fonts-evil"), { recursive: true });
    await writeFile(join(dataHome(), "fonts-evil", "evil.ttf"), "evil");
    studio = new Studio();
    await studio.start(0);
    base = `http://127.0.0.1:${studio.port}`;
  });

  afterAll(async () => {
    await studio?.stop();
  });

  const status = async (path: string) => (await fetch(`${base}${path}`)).status;

  it("keeps /fonts inside the fonts folder (the fonts-evil case)", async () => {
    expect(await status("/fonts/..%2ffonts-evil%2fevil.ttf")).toBe(400);
    expect(await status("/fonts/../fonts-evil/evil.ttf")).not.toBe(200);
    expect(await status("/fonts/%2e%2e%2ffonts-evil%2fevil.ttf")).toBe(400);
  });

  it("never serves run folders or app.json from /media", async () => {
    expect(await status(`/media/${ws.project.id}/render/ok.txt`)).toBe(200);
    expect(await status(`/media/${ws.project.id}/runs/r-20261017000000-0a0a/run.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/RUNS/r-20261017000000-0a0a/run.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/runs`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/app.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/render/..%2fapp.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/..%2f..%2fapp%2fapp.lock`)).toBe(400);
    expect(await status(`/media/${ws.project.id}/render%5c..%5capp.json`)).toBe(400);
    expect(await status(`/media/${ws.project.id}/render/ok.txt%00`)).toBe(400);
    // macOS folds case and Unicode: "runſ" (a long s) and "app.jſon" open runs/ and app.json.
    expect(await status(`/media/${ws.project.id}/run%C5%BF/r-20261017000000-0a0a/run.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/RUN%C5%BF/r-20261017000000-0a0a/run.json`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/app.j%C5%BFon`)).toBe(404);
    expect(await status(`/media/${ws.project.id}/APP.J%C5%BFON`)).toBe(404);
  });

  it("never lets another page frame the app, and never runs a served file as a page", async () => {
    const page = await fetch(`${base}/t/hype-energy`);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const file = await fetch(`${base}/media/${ws.project.id}/render/ok.txt`);
    expect(file.headers.get("x-frame-options")).toBe("DENY");
    expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await fetch(`${base}/api/info`)).headers.get("x-frame-options")).toBe("DENY");
    // An SVG or HTML file in a project is a download, never a page of this origin.
    await writeFile(ws.path("media", "poster.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/settings")</script></svg>');
    const svg = await fetch(`${base}/media/${ws.project.id}/media/poster.svg`);
    expect(svg.headers.get("content-type")).toBe("application/octet-stream");
    expect(svg.headers.get("content-disposition")).toBe("attachment");
  });

  it("refuses a template that names a page or script as its media", async () => {
    const dir = join(dataHome(), "presets", "shared-tpl");
    await mkdir(dir, { recursive: true });
    const hype = JSON.parse(await (await import("node:fs/promises")).readFile(join(process.cwd(), "presets", "hype-energy", "preset.json"), "utf8"));
    await writeFile(join(dir, "preset.json"), JSON.stringify({ ...hype, slug: "shared-tpl", title: "Shared", example: { ...hype.example, poster: "poster.svg" } }));
    await writeFile(join(dir, "poster.svg"), "<svg/>");
    expect(await status("/templates/shared-tpl/poster.svg")).toBe(404);
    const { PresetSchema } = await import("../src/presets/library.js");
    for (const [key, value] of [["example", { poster: "page.html", credit: "x" }], ["cutmap", "map.js"], ["soundtrack", { file: "../x.m4a", title: "t", licence: "MIT" }]] as const) {
      expect(PresetSchema.safeParse({ ...hype, [key]: value }).success, key).toBe(false);
    }
  });

  it("keeps the data home private to this account", async () => {
    const { statSync } = await import("node:fs");
    for (const dir of [dataHome(), join(dataHome(), "projects"), join(dataHome(), "app")]) expect(statSync(dir).mode & 0o077, dir).toBe(0);
  });

  it("validates project ids before touching the disk", async () => {
    expect(await status("/api/projects/%2Ftmp%2Fx")).toBe(400);
    expect(await status("/api/projects/..%2f..%2fetc")).toBe(400);
    expect(await status("/media/%2Ftmp/x")).toBe(400);
    expect(await status("/api/projects/20261017-nothing-here-0000")).toBe(404);
    expect(await status("/media/20261017-nothing-here-0000/x.mp4")).toBe(404);
    expect(await status("/api/projects/%E0%A4%A")).toBe(400);
  });

  it("serves only a template's listed files", async () => {
    expect(await status("/templates/hype-energy/preset.json")).toBe(404);
    expect(await status("/templates/hype-energy/..%2fhype-energy%2fpreset.json")).toBe(404);
    expect(await status("/templates/hype-energy/..%2f..%2fpackage.json")).toBe(400);
    expect(await status("/templates/Hype/x.jpg")).toBe(400);
  });

  it("answers preflights and unmarked writes with 403", async () => {
    expect((await fetch(`${base}/api/info`, { method: "OPTIONS" })).status).toBe(403);
    expect((await fetch(`${base}/api/uploads/0123456789abcdef`, { method: "DELETE" })).status).toBe(403);
    // DNS rebinding: a page on another host name that resolves to 127.0.0.1.
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: studio.port, path: "/api/info", headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(rebound).toBe(403);
    expect((await fetch(`${base}/api/info`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });

  it("caps JSON bodies at 1 MB and refuses bad JSON", async () => {
    const post = (body: string, type = "application/json") =>
      fetch(`${base}/api/projects/${ws.project.id}/reveal`, { method: "POST", headers: { "x-katana": "1", "content-type": type }, body });
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ what: "x".repeat(1024 * 1024 + 10) }))).status).toBe(413);
    expect((await post('{"what":"folder"}', "text/plain")).status).toBe(415);
  });

  it("sets a content security policy on the page", async () => {
    const res = await fetch(`${base}/t/hype-energy`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});
