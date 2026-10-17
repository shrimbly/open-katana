import { existsSync, statSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { backendFromEnv, createBackend } from "../src/comfy/backend.js";
import { type Config, effectiveBackend, loadConfig, nextBackend, saveConfig } from "../src/config.js";
import { State } from "../src/server/state.js";
import { registerProjectTools } from "../src/server/tools-project.js";
import { dataHome } from "../src/util/paths.js";
import { tempDir } from "./helpers/synth.js";

const CLOUD_KEY = "cloud-key-DUMMY";
const ENV_VARS = ["OPEN_KATANA_BACKEND", "COMFYUI_URL", "COMFYUI_TOKEN", "COMFY_CLOUD_API_KEY", "COMFY_CLOUD_URL"] as const;

/** A ComfyUI stand-in that answers both the local and the Cloud API and records every request's headers. */
let server: Server;
let mockUrl: string;
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const saved: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeAll(async () => {
  // The saved config, not the developer's shell, must decide the backend in these tests.
  for (const k of ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const json = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/system_stats") return json({ system: { comfyui_version: "0.0.test" }, devices: [{ name: "mock" }] });
    if (req.url === "/api/user") return json({ id: "u1" });
    if (req.url === "/object_info" || req.url === "/api/object_info") return json({});
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  mockUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
  for (const k of ENV_VARS) if (saved[k] !== undefined) process.env[k] = saved[k];
});

afterEach(() => {
  seen.length = 0;
});

const leaked = () => seen.filter((r) => JSON.stringify(r.headers).includes(CLOUD_KEY));

describe("backend credentials from the environment", () => {
  it("never sends a Comfy Cloud key to a COMFYUI_URL host", async () => {
    const cfg = backendFromEnv({ COMFYUI_URL: mockUrl, COMFY_CLOUD_API_KEY: CLOUD_KEY });
    expect(cfg).toMatchObject({ kind: "http", url: mockUrl });
    expect(cfg.apiKey).toBeUndefined();
    const backend = createBackend(cfg);
    expect((await backend.check()).ok).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(["/system_stats"]);
    expect(leaked()).toEqual([]);
  });

  it("pairs each kind with its own URL and credential variables", () => {
    expect(backendFromEnv({ COMFY_CLOUD_API_KEY: CLOUD_KEY })).toMatchObject({ kind: "cloud", url: undefined, apiKey: CLOUD_KEY });
    // An explicit cloud backend ignores COMFYUI_URL and only uses COMFY_CLOUD_URL.
    expect(backendFromEnv({ OPEN_KATANA_BACKEND: "cloud", COMFYUI_URL: "http://gpu-box.example:8188", COMFY_CLOUD_API_KEY: CLOUD_KEY })).toMatchObject({ kind: "cloud", url: undefined });
    expect(backendFromEnv({ OPEN_KATANA_BACKEND: "cloud", COMFY_CLOUD_URL: "https://staging.cloud.example", COMFY_CLOUD_API_KEY: CLOUD_KEY }).url).toBe("https://staging.cloud.example");
    expect(backendFromEnv({ COMFYUI_URL: "http://gpu-box.example:8188", COMFYUI_TOKEN: "t", COMFY_CLOUD_URL: "https://x.example" })).toMatchObject({ kind: "http", url: "http://gpu-box.example:8188", apiKey: "t" });
    expect(createBackend(backendFromEnv({ OPEN_KATANA_BACKEND: "cloud", COMFYUI_URL: "http://gpu-box.example:8188", COMFY_CLOUD_API_KEY: CLOUD_KEY })).target).toBe("https://cloud.comfy.org");
    expect(effectiveBackend({ tier: "quality", profiles: {}, budgetMinutes: 60, backend: { kind: "cloud", apiKey: "saved" } }, { COMFYUI_URL: "http://gpu-box.example:8188" }).kind).toBe("http");
  });
});

describe("katana_backend set", () => {
  it("carries url and apiKey over only when the kind is unchanged", () => {
    expect(nextBackend({ kind: "cloud", apiKey: CLOUD_KEY }, { kind: "http", url: "http://gpu-box.example:8188" })).toEqual({ kind: "http", url: "http://gpu-box.example:8188" });
    expect(nextBackend({ kind: "http", url: "http://gpu-box.example:8188", apiKey: "token", headers: { "X-Proxy": "1" } }, { kind: "cloud", apiKey: CLOUD_KEY })).toEqual({ kind: "cloud", apiKey: CLOUD_KEY });
    expect(nextBackend({ kind: "cloud", apiKey: CLOUD_KEY }, { kind: "cloud", url: "https://staging.cloud.example" })).toEqual({ kind: "cloud", apiKey: CLOUD_KEY, url: "https://staging.cloud.example" });
    // Switching from a remote ComfyUI to Cloud without a url goes to Comfy Cloud, not the old host.
    expect(createBackend(nextBackend({ kind: "http", url: "http://gpu-box.example:8188" }, { kind: "cloud", apiKey: CLOUD_KEY })).target).toBe("https://cloud.comfy.org");
  });

  const makeBackendTool = () => {
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>>();
    const fake = { registerTool: (name: string, _def: unknown, handler: never) => tools.set(name, handler) } as unknown as McpServer;
    registerProjectTools(fake, new State());
    return tools.get("katana_backend")!;
  };

  it("drops the Cloud key when switching to another ComfyUI", async () => {
    const backendTool = makeBackendTool();

    const cloud = await backendTool({ action: "set", kind: "cloud", url: mockUrl, apiKey: CLOUD_KEY });
    expect(cloud.isError).toBeFalsy();
    expect(seen.some((r) => r.url === "/api/user" && r.headers["x-api-key"] === CLOUD_KEY)).toBe(true);
    seen.length = 0;

    const http = await backendTool({ action: "set", kind: "http", url: mockUrl });
    expect(http.isError).toBeFalsy();
    expect(seen.some((r) => r.url === "/system_stats")).toBe(true);
    expect(leaked()).toEqual([]);
    expect((await loadConfig()).backend).toEqual({ kind: "http", url: mockUrl });
  });

  it("says when the server's environment overrides the saved backend", async () => {
    const backendTool = makeBackendTool();
    process.env.COMFYUI_URL = mockUrl;
    try {
      const r = await backendTool({ action: "set", kind: "http", url: "http://127.0.0.1:9" });
      expect(r.content[0]?.text).toMatch(/^Saved, but COMFYUI_URL in the server's environment overrides the saved backend\./);
      expect(r.content[0]?.text).toContain(`Backend ${mockUrl}`);
      expect((await loadConfig()).backend).toEqual({ kind: "http", url: "http://127.0.0.1:9" });
      // Settings the environment does not override need no note.
      const t = await backendTool({ action: "set", tier: "quality" });
      expect(t.content[0]?.text).not.toContain("Saved, but");
    } finally {
      delete process.env.COMFYUI_URL;
    }
  });
});

describe("config file", () => {
  it("is private to the user, even when it already existed", async () => {
    const before = process.env.OPEN_KATANA_HOME;
    process.env.OPEN_KATANA_HOME = join(await tempDir("ok-cfg-"), "home");
    try {
      const cfg: Config = { tier: "quality", profiles: {}, budgetMinutes: 60, backend: { kind: "cloud", apiKey: CLOUD_KEY } };
      await saveConfig(cfg);
      expect(statSync(dataHome()).mode & 0o777).toBe(0o700);
      const file = join(dataHome(), "config.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      await chmod(file, 0o644);
      await saveConfig(cfg);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(file) && JSON.parse(await readFile(file, "utf8")).backend.apiKey).toBe(CLOUD_KEY);
    } finally {
      process.env.OPEN_KATANA_HOME = before;
    }
  });
});
