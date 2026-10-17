import { join } from "node:path";
import { type Backend, createBackend } from "../comfy/backend.js";
import { type Config, effectiveBackend, loadConfig, saveConfig } from "../config.js";
import { projectsRoot, Workspace } from "../project/workspace.js";
import { APP_REFUSAL, appRun } from "./app-mode.js";

/**
 * The run's profile overrides (OPEN_KATANA_PROFILE_OVERRIDES, JSON; null restores the default) and
 * commercial switch (OPEN_KATANA_COMMERCIAL, "1"/"0") on top of the saved config, without saving them.
 */
export function withRunOverrides(cfg: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const next: Config = { ...cfg, profiles: { ...cfg.profiles } };
  if (env.OPEN_KATANA_PROFILE_OVERRIDES) {
    const overrides = JSON.parse(env.OPEN_KATANA_PROFILE_OVERRIDES) as Record<string, string | null>;
    for (const [op, id] of Object.entries(overrides)) {
      if (id === null) delete next.profiles[op];
      else if (typeof id === "string") next.profiles[op] = id;
    }
  }
  if (env.OPEN_KATANA_COMMERCIAL === "1") next.commercial = true;
  else if (env.OPEN_KATANA_COMMERCIAL === "0") next.commercial = false;
  return next;
}

/** Process-wide state shared by the tools: configuration and one backend client. */
export class State {
  private backendCache?: Backend;
  private configCache?: Config;

  async config(): Promise<Config> {
    this.configCache ??= withRunOverrides(await loadConfig());
    return this.configCache;
  }

  async updateConfig(patch: Partial<Config>): Promise<Config> {
    if (appRun()) throw new Error(APP_REFUSAL);
    const next = { ...(await this.config()), ...patch };
    await saveConfig(next);
    this.configCache = next;
    this.backendCache = undefined;
    return next;
  }

  async backend(): Promise<Backend> {
    this.backendCache ??= createBackend(effectiveBackend(await this.config()));
    return this.backendCache;
  }

  /**
   * Opens a project by id, or the most recently updated one when no id is given. In app runs the
   * server is pinned to its run's project: no id means that project, any other id is refused, and the
   * id is always resolved under the projects root (never as a directory path).
   */
  async workspace(id?: string): Promise<Workspace> {
    const run = appRun();
    if (run) {
      if (id && id !== run.project) throw new Error(`[LOCKED] This run only works on project ${run.project}.`);
      return Workspace.open(join(projectsRoot(), run.project));
    }
    if (id) return Workspace.open(id);
    const [latest] = await Workspace.list();
    if (!latest) throw new Error("No open-katana projects yet. Start one with katana_start.");
    return Workspace.open(latest.id);
  }
}
