import type { ModelChoices } from "./backend.js";
import type { ApiPrompt } from "./graph.js";
import type { Profile } from "./operations.js";

const PRECISION = /(^|[-_.])(fp8|fp16|bf16|fp32|fp8mixed|fp4mixed|fp8_scaled|e4m3fn|e5m2|scaled|mixed|int8|convrot)(?=$|[-_.])/g;

/** A model filename without extension, case and precision tags: "flux-2-klein-9b-fp8.safetensors" → "flux-2-klein-9b". */
export function modelStem(name: string): string {
  let stem = name.toLowerCase().replace(/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/, "");
  let prev = "";
  while (prev !== stem) {
    prev = stem;
    stem = stem.replace(PRECISION, "");
  }
  return stem.replace(/[-_.]+$/, "");
}

export interface ResolvedModels {
  prompt: ApiPrompt;
  /** Requested name → name actually used, for every substitution. */
  substituted: Record<string, string>;
  /** Models with no available variant on the backend. */
  missing: { node: string; input: string; name: string }[];
}

/**
 * Replaces each model filename in a prompt with the variant the backend actually has
 * (same stem, different precision), and reports models that are not available at all.
 */
export function resolveModels(prompt: ApiPrompt, models: ModelChoices): ResolvedModels {
  const out: ApiPrompt = structuredClone(prompt);
  const substituted: Record<string, string> = {};
  const missing: ResolvedModels["missing"] = [];
  for (const [id, node] of Object.entries(out)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value)) continue;
      const choices = models.get(input);
      if (!choices) continue;
      if (choices.has(value)) continue;
      const stem = modelStem(value);
      const candidates = [...choices].filter((c) => modelStem(c) === stem);
      // Prefer the same precision family as requested, then fp8 variants (smaller), then anything.
      const wantsFp8 = /fp8/i.test(value);
      const pick = candidates.sort((a, b) => Number(/fp8/i.test(b) === wantsFp8) - Number(/fp8/i.test(a) === wantsFp8))[0];
      if (pick) {
        node.inputs[input] = pick;
        substituted[value] = pick;
      } else {
        missing.push({ node: id, input, name: value });
      }
    }
  }
  return { prompt: out, substituted, missing };
}

export interface ProfileAvailability {
  profile: string;
  runnable: boolean;
  missingModels: string[];
  missingNodes: string[];
}

/** Checks a profile against a backend catalog: every node class present and every model resolvable. */
export function checkProfile(p: Profile, catalog: { nodes: Set<string>; models: ModelChoices }): ProfileAvailability {
  const missingNodes = p.nodes.filter((n) => catalog.nodes.size > 0 && !catalog.nodes.has(n));
  const all = new Set<string>();
  for (const set of catalog.models.values()) for (const m of set) all.add(m);
  const stems = new Set([...all].map(modelStem));
  const missingModels = p.models.filter((m) => !all.has(m.name) && !stems.has(modelStem(m.name))).map((m) => `${m.folder}/${m.name}`);
  return { profile: p.id, runnable: !missingNodes.length && !missingModels.length, missingModels, missingNodes };
}
