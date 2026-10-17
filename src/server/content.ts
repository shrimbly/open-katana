import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { run } from "../util/proc.js";

export type Content = CallToolResult["content"][number];

export const text = (t: string): Content => ({ type: "text", text: t });

const MAX_SIDE = 1568;
const MAX_BYTES = 900 * 1024;

/** Loads an image for the model: downscaled to fit vision limits and re-encoded as JPEG when large. */
export async function image(path: string): Promise<Content> {
  const size = (await stat(path)).size;
  const isJpeg = /\.jpe?g$/i.test(path);
  if (isJpeg && size <= MAX_BYTES) {
    const dims = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]);
    const [w, h] = dims.stdout.toString().trim().split(",").map(Number);
    if ((w ?? 0) <= MAX_SIDE && (h ?? 0) <= MAX_SIDE) {
      return { type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/jpeg" };
    }
  }
  const out = join(tmpdir(), `ok-img-${randomBytes(4).toString("hex")}.jpg`);
  try {
    for (const quality of [3, 6, 10]) {
      await run("ffmpeg", [
        "-v", "error", "-y", "-i", path, "-frames:v", "1",
        "-vf", `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
        "-q:v", String(quality), out,
      ]);
      if ((await stat(out)).size <= MAX_BYTES) break;
    }
    return { type: "image", data: (await readFile(out)).toString("base64"), mimeType: "image/jpeg" };
  } finally {
    await rm(out, { force: true });
  }
}

/** A tool result with a readable summary, the same data as structured content, and optional images. */
export function result(summary: string, data?: Record<string, unknown>, images: Content[] = []): CallToolResult {
  return {
    content: [text(summary), ...images],
    ...(data ? { structuredContent: data } : {}),
  };
}

export function fail(message: string): CallToolResult {
  return { content: [text(message)], isError: true };
}

/** Markdown table from rows of plain values. */
export function table(headers: string[], rows: (string | number | undefined)[][]): string {
  const esc = (v: string | number | undefined) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

/** What a tool body may use of the request: its abort signal (the client cancelled the call). */
export interface ToolRequest {
  mcpReq?: { signal?: AbortSignal };
}

/** Wraps a tool body so thrown errors become readable tool errors instead of protocol failures. */
export function safe<A>(fn: (args: A, req?: ToolRequest) => Promise<CallToolResult>): (args: A, req?: ToolRequest) => Promise<CallToolResult> {
  return async (args: A, req?: ToolRequest) => {
    try {
      return await fn(args, req);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
