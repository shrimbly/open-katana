import type { McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Workspace } from "../src/project/workspace.js";
import { State } from "../src/server/state.js";
import { registerGenerationTools } from "../src/server/tools-generate.js";
import { registerProjectTools } from "../src/server/tools-project.js";

type Tool = (args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;
type Job = { line: string; profile: string; license: { name: string; commercial: string } };

describe("licences in katana_backend and katana_plan", () => {
  const tools = new Map<string, Tool>();
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!(args);
  const textOf = (r: Awaited<ReturnType<Tool>>) => r.content.map((c) => c.text ?? "").join("\n");
  let project: string;
  const jobs = [
    { line: "plate1", operation: "still.generate", prompt: "empty street at night" },
    { line: "key1", operation: "still.compose", prompt: "the person from image 1 in a doorway" },
    { line: "v1", operation: "clip.r2v", prompt: "the person walks out", durationSec: 2 },
  ];
  const plan = (extra: Record<string, unknown>[] = []) =>
    call("katana_plan", { project, plan: { concept: "licence test", shots: [{ at: "0-2", role: "hero", description: "walk out", route: "i2v", lines: ["v1"] }], jobs: [...jobs, ...extra] } });

  beforeAll(async () => {
    // Nothing listens here: the plan needs no backend, and status still reports licences.
    process.env.OPEN_KATANA_BACKEND = "http";
    process.env.COMFYUI_URL = "http://127.0.0.1:9";
    delete process.env.COMFY_CLOUD_API_KEY;
    const fake = { registerTool: (name: string, _def: unknown, handler: Tool) => tools.set(name, handler) } as unknown as McpServer;
    const state = new State();
    registerProjectTools(fake, state);
    registerGenerationTools(fake, state);
    project = (await Workspace.create({ title: "licence test" })).project.id;
  });

  it("discloses the default keyframe model's non-commercial licence", async () => {
    const r = await plan();
    expect(r.isError).toBeFalsy();
    const est = r.structuredContent as { jobs: Job[]; licenseWarnings: string[]; commercial: boolean };
    expect(est.commercial).toBe(false);
    expect(est.jobs.find((j) => j.line === "key1")).toMatchObject({ profile: "qwen21-edit", license: { name: "Qwen Research License", commercial: "no" } });
    // Plates come from the keyframe model's weights, so they carry the same non-commercial licence.
    expect(est.jobs.find((j) => j.line === "plate1")).toMatchObject({ profile: "qwen21", license: { name: "Qwen Research License", commercial: "no" } });
    expect(est.licenseWarnings.some((w) => w.startsWith("qwen21-edit: Qwen Research License, non-commercial"))).toBe(true);
    expect(est.licenseWarnings.some((w) => w.startsWith("minimax-h3-r2v: MiniMax H3 Community License, restricted"))).toBe(true);
    expect(textOf(r)).toContain("Licence warnings");
    expect(textOf(r)).toContain("commercial: true");
  });

  it("lists each operation's default with its licence, and switches defaults with commercial: true", async () => {
    const status = await call("katana_backend", { action: "status" });
    const active = (status.structuredContent!.active as { operation: string; profile: string }[]).find((a) => a.operation === "still.compose");
    expect(active!.profile).toBe("qwen21-edit");
    expect(textOf(status)).toContain("Profile per operation");
    expect(status.structuredContent!.licenseWarnings).toEqual(expect.arrayContaining([expect.stringMatching(/^qwen21-edit: /)]));

    const set = await call("katana_backend", { action: "set", commercial: true });
    expect(set.structuredContent!.commercial).toBe(true);
    expect((set.structuredContent!.active as { operation: string; profile: string }[]).find((a) => a.operation === "still.compose")!.profile).toBe("boogu-edit");
    expect((await loadConfig()).commercial).toBe(true);
  });

  it("keeps an explicitly named non-commercial profile under commercial: true, with a warning", async () => {
    const r = await plan([{ line: "key2", operation: "still.compose", profile: "qwen21-edit", prompt: "the person by a window" }]);
    const est = r.structuredContent as { jobs: Job[]; licenseWarnings: string[]; commercial: boolean };
    expect(est.commercial).toBe(true);
    expect(est.jobs.find((j) => j.line === "key1")).toMatchObject({ profile: "boogu-edit", license: { commercial: "yes" } });
    expect(est.jobs.find((j) => j.line === "key2")!.profile).toBe("qwen21-edit");
    expect(est.licenseWarnings.find((w) => w.startsWith("qwen21-edit"))).toContain("named explicitly");
  });
});
