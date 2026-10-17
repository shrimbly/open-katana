import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, found by walking up from this module to the directory holding package.json. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("open-katana package root not found");
    dir = parent;
  }
  return dir;
}

export const assetPath = (...parts: string[]) => join(packageRoot(), "assets", ...parts);

/** User data directory: projects, presets, caches. Override with OPEN_KATANA_HOME. */
export function dataHome(): string {
  return resolve(process.env.OPEN_KATANA_HOME ?? join(homedir(), ".open-katana"));
}

/**
 * Makes the data home and the folders that hold the person's photos, briefs and the director's transcript
 * readable by this account only (0700), creating them when missing and narrowing them when an older build
 * (or the umask) left them open to other accounts. Best effort: a folder it can't change is left as it is.
 */
export async function securePrivateDirs(): Promise<void> {
  if (process.platform === "win32") return;
  const { chmod, mkdir, stat } = await import("node:fs/promises");
  const home = dataHome();
  for (const dir of [home, join(home, "app"), join(home, "app", "inbox"), join(home, "projects"), join(home, "trash")]) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const st = await stat(dir);
      if ((st.mode & 0o077) !== 0) await chmod(dir, (st.mode & 0o700) | 0o700);
    } catch {
      // Leave it.
    }
  }
}
