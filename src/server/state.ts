import { type Backend, createBackend } from "../comfy/backend.js";
import { type Config, effectiveBackend, loadConfig, saveConfig } from "../config.js";
import { Workspace } from "../project/workspace.js";

/** Process-wide state shared by the tools: configuration and one backend client. */
export class State {
  private backendCache?: Backend;
  private configCache?: Config;

  async config(): Promise<Config> {
    this.configCache ??= await loadConfig();
    return this.configCache;
  }

  async updateConfig(patch: Partial<Config>): Promise<Config> {
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

  /** Opens a project by id, or the most recently updated one when no id is given. */
  async workspace(id?: string): Promise<Workspace> {
    if (id) return Workspace.open(id);
    const [latest] = await Workspace.list();
    if (!latest) throw new Error("No open-katana projects yet. Start one with katana_start.");
    return Workspace.open(latest.id);
  }
}
