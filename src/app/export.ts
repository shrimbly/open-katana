import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { RenderMode } from "../project/render-project.js";
import { slugify, type Workspace } from "../project/workspace.js";
import { deliver } from "../render/deliver.js";
import { EdlSchema } from "../render/edl.js";
import { run } from "../util/proc.js";
import type { Hub } from "./hub.js";
import { withProject } from "./projects.js";
import { HttpError } from "./router.js";
import type { ProjectEvent } from "./types.js";

// Server-side export (spec §11.6): render the master through the studio's render queue, deliver it as the
// next version, and write a silent copy when the edit keeps the original video's sound (D6).

/** Renders a project in the studio's queue and resolves when that render has finished. */
export type Renderer = (ws: Workspace, mode: RenderMode, onProgress: (done: number, total: number) => void) => Promise<unknown>;

const exporting = new Set<string>();
const nextNote = new Map<string, string>();

/** What the next app export's version note says (a pick swapped in, rather than words changed). */
export function noteNextExport(project: string, note: string): void {
  nextNote.set(project, note);
}

export function isExporting(project: string): boolean {
  return exporting.has(project);
}

/** `<v>_silent.mp4` next to a delivered file: the picture only, stream-copied. */
export function silentPath(file: string): string {
  return file.replace(/\.mp4$/i, "_silent.mp4");
}

export async function writeSilentCopy(file: string): Promise<string> {
  const out = silentPath(file);
  await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-an", "-c:v", "copy", out]);
  return out;
}

export interface Delivered {
  version: number;
  /** Absolute path of the delivered file. */
  path: string;
  url: string;
  silentUrl?: string;
  sizeMB: number;
}

/**
 * Delivers render/master.mp4 as the project's next version (deliver/<slug>_v<n>.mp4), adds the version to
 * project.json inside `withProject`, and writes the silent copy when the EDL plays the reference's sound.
 * Answers 409 NO_EDIT when there is no master to deliver.
 */
export async function deliverVersion(project: string, note: string): Promise<Delivered> {
  return withProject(project, async (ws) => {
    const master = ws.path("render", "master.mp4");
    if (!existsSync(master)) throw new HttpError(409, "Render the final version first.", "NO_EDIT");
    const version = ws.project.versions.length + 1;
    const out = ws.path("deliver", `${slugify(ws.project.title)}_v${version}.mp4`);
    const d = await deliver(master, out);
    ws.project.versions.push({ version, path: ws.rel(out), createdAt: new Date().toISOString(), note });
    await ws.save();
    const edl = await ws.readJson("render/edl.json", EdlSchema).catch(() => undefined);
    const url = `/media/${ws.project.id}/${ws.rel(out).split(/[\\/]/).join("/")}`;
    let silentUrl: string | undefined;
    if (edl?.audio?.asset === "ref") {
      await writeSilentCopy(out);
      silentUrl = silentPath(url);
    }
    return { version, path: out, url, silentUrl, sizeMB: d.sizeMB };
  });
}

/**
 * Starts an export in the background: progress, the new version or the error arrive as `export` events on
 * the project channel. False when one is already running for this project.
 */
export function startExport(ws: Workspace, deps: { render: Renderer; hub: Hub; onDelivered?: (project: string) => void }): boolean {
  const id = ws.project.id;
  if (exporting.has(id)) return false;
  exporting.add(id);
  const emit = (e: Omit<Extract<ProjectEvent, { type: "export" }>, "type">) => deps.hub.project(id, { type: "export", ...e });
  let last = 0;
  void (async () => {
    try {
      emit({ state: "rendering", done: 0, total: 0 });
      await deps.render(ws, "master", (done, total) => {
        const now = Date.now();
        if (now - last < 250 && done < total) return;
        last = now;
        emit({ state: "rendering", done, total });
      });
      const note = nextNote.get(id) ?? "words changed in the app";
      nextNote.delete(id);
      const d = await deliverVersion(id, note);
      deps.onDelivered?.(id);
      emit({ state: "done", version: d.version, url: d.url });
      deps.hub.global({ type: "projects" });
    } catch (e) {
      emit({ state: "error", error: (e as Error).message });
    } finally {
      exporting.delete(id);
    }
  })();
  return true;
}

/** Size in MB of a delivered file, for version lists. */
export async function sizeMB(file: string): Promise<number | undefined> {
  const s = await stat(file).catch(() => undefined);
  return s ? Math.round((s.size / 2 ** 20) * 100) / 100 : undefined;
}
