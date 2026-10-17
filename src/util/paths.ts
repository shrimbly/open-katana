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
