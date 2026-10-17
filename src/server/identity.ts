import { existsSync } from "node:fs";
import type { Workspace } from "../project/workspace.js";
import { assetPath } from "../util/paths.js";
import { run } from "../util/proc.js";

/**
 * A side-by-side panel of the subject photo and one or more generated pictures (the takes of a
 * line), so identity is judged by direct comparison (face shape, skin tone, jaw, eyes, hairline,
 * eyewear) and the best take is easy to pick. For a clip, its middle frame is used. Returns
 * undefined when the project has no subject photo.
 */
export async function identityPanel(ws: Workspace, assetIds: string | string[], subjectId?: string): Promise<string | undefined> {
  const subject = subjectId ? ws.asset(subjectId) : ws.subjects()[0];
  if (!subject || subject.kind !== "image") return undefined;
  const candidates = (Array.isArray(assetIds) ? assetIds : [assetIds]).map((id) => ws.asset(id)).filter((c) => c.kind !== "audio");
  if (!candidates.length) return undefined;
  const out = ws.path("qa", `${candidates.map((c) => c.id).join("+")}-vs-${subject.id}.jpg`);
  if (existsSync(out)) return out;
  const font = assetPath("fonts", "JetBrainsMono.ttf").replace(/\\/g, "/").replace(/:/g, "\\:");
  const height = candidates.length > 1 ? 560 : 720;
  const label = (text: string) => `drawtext=fontfile='${font}':text='${text.replace(/[':\\]/g, "")}':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
  const inputs = ["-i", ws.path(subject.path)];
  for (const c of candidates) {
    if (c.kind === "video") inputs.push("-ss", String(Math.max(0, (c.durationSec ?? 0) / 2)));
    inputs.push("-i", ws.path(c.path));
  }
  const chains = [`[0:v]scale=-2:${height},${label("SUBJECT")}[s]`, ...candidates.map((c, i) => `[${i + 1}:v]scale=-2:${height},${label(c.id)}[c${i}]`)];
  const stack = `[s]${candidates.map((_, i) => `[c${i}]`).join("")}hstack=inputs=${candidates.length + 1}`;
  await run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${chains.join(";")};${stack}`, "-frames:v", "1", "-q:v", "3", out]);
  return out;
}
