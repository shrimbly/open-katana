import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../project/workspace.js";
import { appDir } from "./http.js";
import { HttpError } from "./router.js";
import { AppSettingsPatchSchema, AppSettingsSchema, DEFAULT_APP_SETTINGS } from "./schemas.js";
import type { AppSettings } from "./types.js";

// App settings live in ~/.open-katana/app/settings.json, not config.json (spec D12): ConfigSchema
// strips unknown keys, so `katana_backend set` would erase anything the app kept there.

const settingsFile = () => join(appDir(), "settings.json");

/** Saved settings over the defaults. A missing or unreadable file gives the defaults. */
export async function loadSettings(): Promise<AppSettings> {
  const file = settingsFile();
  if (!existsSync(file)) return { ...DEFAULT_APP_SETTINGS, licencesAcknowledged: [] };
  try {
    const parsed = AppSettingsSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the defaults.
  }
  return { ...DEFAULT_APP_SETTINGS, licencesAcknowledged: [] };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Merges `patch` into the saved settings. `licencesAcknowledged` only grows: ids in the patch are
 * added, and "Show them again" sends an empty list to clear it.
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const parsed = AppSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; "), "BAD_SETTINGS");
  // One save at a time, so two quick changes cannot drop each other.
  const next = queue.then(async () => {
    const current = await loadSettings();
    const p = parsed.data;
    const merged: AppSettings = {
      ...current,
      ...p,
      licencesAcknowledged: p.licencesAcknowledged === undefined ? current.licencesAcknowledged : p.licencesAcknowledged.length ? [...new Set([...current.licencesAcknowledged, ...p.licencesAcknowledged])] : [],
    };
    await writeFileAtomic(settingsFile(), `${JSON.stringify(merged, null, 2)}\n`);
    return merged;
  });
  queue = next.catch(() => undefined);
  return next;
}
