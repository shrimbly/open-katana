import { controlModels, defaultProfile, type ModelFile, OPERATIONS } from "./operations.js";

export interface ManifestEntry {
  name: string;
  /** The ComfyUI models folder it goes in (diffusion_models, loras, vae, …). */
  folder: string;
  url: string;
  /** Size in bytes, as the download serves it (filled in by `withSizes`). */
  bytes?: number;
  /** What loads it: operation (profile), or the camera-move depth pass. */
  uses: string[];
}

/**
 * Every model file the default workflows of a tier load, each listed once with what uses it: the default
 * profile of each operation, the camera-move route (MiniMax H3 + Fun ControlNet Union, steered by Marigold V2
 * depth) and the upscale. This is what a local or remote ComfyUI needs to run open-katana's edits.
 */
export function modelManifest(tier: "quality" | "lite" = "quality", opts: { commercial?: boolean } = {}): ManifestEntry[] {
  const out = new Map<string, ManifestEntry>();
  const add = (m: ModelFile, use: string) => {
    const e = out.get(m.name) ?? { name: m.name, folder: m.folder, url: m.url, uses: [] };
    if (!e.uses.includes(use)) e.uses.push(use);
    out.set(m.name, e);
  };
  for (const op of OPERATIONS) {
    const p = defaultProfile(op, tier, undefined, { commercial: opts.commercial });
    for (const m of p.models) add(m, `${op} (${p.id})`);
  }
  const camera = defaultProfile("clip.motion", tier, undefined, { commercial: opts.commercial, control: "camera" });
  for (const m of camera.models) add(m, `camera moves (${camera.id})`);
  for (const m of controlModels("depth")) add(m, "camera moves (Marigold V2 depth)");
  return [...out.values()];
}

/** The manifest with each file's size, from a HEAD request to its download URL. */
export async function withSizes(entries: ManifestEntry[]): Promise<ManifestEntry[]> {
  return Promise.all(
    entries.map(async (e) => {
      const res = await fetch(e.url, { method: "HEAD", redirect: "follow" });
      if (!res.ok) throw new Error(`${e.name}: ${res.status} from ${e.url}`);
      const bytes = Number(res.headers.get("x-linked-size") ?? res.headers.get("content-length") ?? 0);
      if (!bytes) throw new Error(`${e.name}: no size from ${e.url}`);
      return { ...e, bytes };
    }),
  );
}
