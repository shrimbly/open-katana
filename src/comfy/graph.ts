/** A link to output `slot` of node `id`, as used in ComfyUI API-format prompts. */
export type Link = [string, number];

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

export type ApiPrompt = Record<string, ApiNode>;

/** Minimal builder for ComfyUI API-format graphs with sequential string ids. */
export class Graph {
  readonly nodes: ApiPrompt = {};
  private next = 1;

  add(classType: string, inputs: Record<string, unknown>, title?: string): string {
    const id = String(this.next++);
    this.nodes[id] = { class_type: classType, inputs, ...(title ? { _meta: { title } } : {}) };
    return id;
  }

  /** Adds a node and returns a link to its first output. */
  link(classType: string, inputs: Record<string, unknown>, title?: string, slot = 0): Link {
    return [this.add(classType, inputs, title), slot];
  }

  toJSON(): ApiPrompt {
    return this.nodes;
  }

  /** Model filenames referenced by loader nodes, grouped by the input that names them. */
  modelRefs(): { node: string; input: string; name: string }[] {
    const refs: { node: string; input: string; name: string }[] = [];
    for (const [id, n] of Object.entries(this.nodes)) {
      for (const [k, v] of Object.entries(n.inputs)) {
        if (typeof v === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(v)) refs.push({ node: id, input: k, name: v });
      }
    }
    return refs;
  }
}

/** Wan models need 4n+1 frames. Returns the smallest valid count ≥ `frames`. */
export function wanFrames(frames: number): number {
  const n = Math.max(1, Math.ceil((Math.max(1, frames) - 1) / 4));
  return 4 * n + 1;
}

/** MiniMax H3 needs 17n+5 frames (5, 22, 39, 56, …). Returns the smallest valid count ≥ `frames`. */
export function h3Frames(frames: number): number {
  const n = Math.max(5, Math.round(frames));
  return n + ((5 - (n % 17) + 17) % 17);
}

/** Rounds a dimension to a multiple of `step` (16 for most diffusion models). */
export function snap(value: number, step = 16): number {
  return Math.max(step, Math.round(value / step) * step);
}

/** Picks a generation size with the given aspect ratio and long side, snapped to multiples of 16. */
export function sizeForAspect(aspect: number, longSide: number, step = 16): { width: number; height: number } {
  if (aspect >= 1) return { width: snap(longSide, step), height: snap(longSide / aspect, step) };
  return { width: snap(longSide * aspect, step), height: snap(longSide, step) };
}
