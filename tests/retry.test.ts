import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Backend, JobPoll } from "../src/comfy/backend.js";
import { isTransientError, submitJobs, waitJobs } from "../src/comfy/jobs.js";
import { Workspace } from "../src/project/workspace.js";
import { run } from "../src/util/proc.js";

const H3_FLAKE = "RuntimeError: The size of tensor a (613) must match the size of tensor b (576) at non-singleton dimension 0 (node 12 MiniMaxH3ImageToVideo)";
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A backend whose prompts fail with the given errors in turn, then complete with a tiny PNG. */
function fakeBackend(errors: string[]): Backend & { sent: unknown[]; cancelled: string[] } {
  const sent: unknown[] = [];
  const cancelled: string[] = [];
  const fate = new Map<string, string | undefined>();
  return {
    kind: "http",
    target: "fake",
    sent,
    cancelled,
    check: async () => ({ ok: true }) as never,
    catalog: async () => undefined,
    upload: async (p: string) => p,
    async submit(prompt) {
      sent.push(prompt);
      const id = `p${sent.length}`;
      fate.set(id, errors[sent.length - 1]);
      return id;
    },
    async poll(id): Promise<JobPoll> {
      const error = fate.get(id);
      return error ? { state: "error", outputs: [], error } : { state: "completed", outputs: [{ nodeId: "9", filename: `${id}.png`, subfolder: "", type: "output" }] };
    },
    async download(_f, dest) {
      await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x64", "-frames:v", "1", dest]);
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
}

async function project(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "ok-retry-"));
  dirs.push(root);
  return Workspace.create({ title: "retry", root });
}

const spec = { line: "plate1", operation: "still.generate" as const, profile: "z-image-turbo", prompt: "empty street", takes: 1 };

describe("server errors that aren't about the job", () => {
  it("recognise MiniMax H3's tensor-size flake and expired node logins, not ordinary failures", () => {
    expect(isTransientError(H3_FLAKE)).toBe(true);
    expect(isTransientError("Unauthorized: Please login first to use this node")).toBe(true);
    expect(isTransientError("RuntimeError: The size of tensor a (40) must match the size of tensor b (41) (node 7 VAEDecode)")).toBe(false);
    expect(isTransientError("Value not in list: unet_name")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it("send the same prompt again once, and finish on the retry", async () => {
    const ws = await project();
    const backend = fakeBackend([H3_FLAKE]);
    await submitJobs(ws, backend, [spec], { tier: "quality", overrides: {} });
    const [job] = await waitJobs(ws, backend, { timeoutSec: 20, intervalSec: 0.05 });
    expect(job).toMatchObject({ state: "completed", retries: 1, promptId: "p2" });
    expect(backend.sent).toHaveLength(2);
    expect(backend.sent[1]).toEqual(backend.sent[0]);
  });

  it("give up after one retry and say to resubmit unchanged", async () => {
    const ws = await project();
    const backend = fakeBackend([H3_FLAKE, H3_FLAKE]);
    await submitJobs(ws, backend, [spec], { tier: "quality", overrides: {} });
    const [job] = await waitJobs(ws, backend, { timeoutSec: 20, intervalSec: 0.05 });
    expect(job!.state).toBe("error");
    expect(job!.error).toMatch(/sent twice.*resubmit it unchanged/);
    expect(backend.sent).toHaveLength(2);
  });

  it("never resend a job that failed because of its inputs", async () => {
    const ws = await project();
    const backend = fakeBackend(["Value not in list: unet_name"]);
    await submitJobs(ws, backend, [spec], { tier: "quality", overrides: {} });
    const [job] = await waitJobs(ws, backend, { timeoutSec: 20, intervalSec: 0.05 });
    expect(job).toMatchObject({ state: "error", error: "Value not in list: unet_name" });
    expect(job!.retries).toBeUndefined();
    expect(backend.sent).toHaveLength(1);
  });
});
