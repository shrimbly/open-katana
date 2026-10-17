import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type BackendConfig, type BackendKind, backendFromEnv } from "./comfy/backend.js";
import { dataHome } from "./util/paths.js";

export const ConfigSchema = z.object({
  backend: z
    .object({
      kind: z.enum(["http", "cloud", "comfy-cli"]),
      url: z.string().optional(),
      apiKey: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      where: z.enum(["cloud", "local"]).optional(),
    })
    .optional(),
  /** "quality" (A14B-class models) or "lite" (5B/klein models for 24–48 GB machines). */
  tier: z.enum(["quality", "lite"]).default("quality"),
  /** Per-operation profile overrides, e.g. { "clip.i2v": "wan22-5b-ti2v" }. */
  profiles: z.record(z.string(), z.string()).default({}),
  /** Default GPU-minutes budget per project; generation stops at this cap. */
  budgetMinutes: z.number().positive().default(60),
  /** Output is for commercial use: defaults skip non-commercial models, and restricted ones are warned about. */
  commercial: z.boolean().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

const configPath = () => join(dataHome(), "config.json");

export async function loadConfig(): Promise<Config> {
  const file = configPath();
  const raw = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  return ConfigSchema.parse(raw);
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(dataHome(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFile's mode only applies to a new file; an existing config.json may be world-readable.
  await chmod(configPath(), 0o600);
}

/**
 * The backend after `katana_backend set`. The old url and apiKey carry over only when the kind is
 * unchanged, so a Comfy Cloud key never follows a switch to another host (or the other way round).
 */
export function nextBackend(prev: Config["backend"], patch: { kind: BackendKind; url?: string; apiKey?: string }): NonNullable<Config["backend"]> {
  const base = prev?.kind === patch.kind ? prev : {};
  return { ...base, kind: patch.kind, ...(patch.url ? { url: patch.url } : {}), ...(patch.apiKey ? { apiKey: patch.apiKey } : {}) };
}

/** The set environment variables that choose the backend; any one of them overrides the saved backend. */
export function backendEnvOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["OPEN_KATANA_BACKEND", "COMFYUI_URL", "COMFY_CLOUD_API_KEY"].filter((v) => env[v]);
}

/** Environment variables win over the config file so one-off runs need no edits. */
export function effectiveBackend(cfg: Config, env: NodeJS.ProcessEnv = process.env): BackendConfig {
  if (backendEnvOverrides(env).length || !cfg.backend) return backendFromEnv(env);
  return cfg.backend;
}
