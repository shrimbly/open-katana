import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelManifest } from "../src/comfy/manifest.js";

describe("the model manifest", () => {
  it("lists every file the default workflows load, once, with the camera route and the upscale", () => {
    const q = modelManifest("quality");
    expect(new Set(q.map((f) => f.name)).size).toBe(q.length);
    const names = q.map((f) => f.name);
    expect(names).toContain("qwen_image_2.1_int8_convrot.safetensors");
    expect(names).toContain("minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors");
    expect(names).toContain("marigold_v2_depth_log_stage2.safetensors");
    expect(names).toContain("seedvr2_7b_sharp_int8_convrot.safetensors");
    expect(q.find((f) => f.name === "marigold_v2_depth_conditioning.safetensors")?.folder).toBe("embeddings");
  });

  it("is what docs/models-manifest.json says (regenerate it with `open-katana models --json`)", () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), "docs", "models-manifest.json"), "utf8")) as Record<"quality" | "lite", { name: string; folder: string; url: string; bytes: number }[]>;
    for (const tier of ["quality", "lite"] as const) {
      const strip = (fs: { name: string; folder: string; url: string }[]) => fs.map(({ name, folder, url }) => ({ name, folder, url }));
      expect(strip(committed[tier]), tier).toEqual(strip(modelManifest(tier)));
      expect(committed[tier].every((f) => f.bytes > 0), `${tier} sizes`).toBe(true);
    }
  });
});
