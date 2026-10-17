import type { CutMapShot, SetupStatus, Take, TemplateCard } from "../../../src/app/types.js";

/**
 * What several screens say, worked out from the server's data. Pure (no DOM, no fetch), so the unit
 * tests in tests/smoke/app-client.test.ts can check it without a browser.
 */

// ---------- setup ----------

type Profile = SetupStatus["gpu"]["profiles"][number];

/**
 * The models (or nodes) worth reporting as missing. When the server knows which templates use each
 * operation, profiles no template needs (say, motion clips) are left out; the receipt says if an edit
 * needs them.
 */
export function missingProfiles(s: SetupStatus): Profile[] {
  const known = s.gpu.profiles.some((p) => p.neededBy);
  return s.gpu.profiles.filter((p) => !p.ready && (!known || Boolean(p.neededBy?.length)));
}

/**
 * True when missing models leave no template that can be made: every title in `templates` is needed
 * by some missing profile. False while the GPU itself isn't working (that is its own message) or the
 * template list isn't known yet.
 */
export function modelsBlockEveryTemplate(s: SetupStatus, templates: readonly string[] | undefined): boolean {
  if (s.gpu.state !== "ok" || !templates?.length) return false;
  const blocked = new Set(missingProfiles(s).flatMap((p) => p.neededBy ?? []));
  return templates.every((t) => blocked.has(t));
}

/** "Comfy Cloud", "This computer" or the remote host. */
export function gpuName(s: SetupStatus): string {
  const g = s.gpu;
  if (g.where === "cloud" || g.kind === "cloud" || g.kind === "comfy-cli") return "Comfy Cloud";
  if (g.where === "local") return "This computer";
  try {
    return g.target ? new URL(g.target).host : (g.detail ?? "Your GPU");
  } catch {
    return g.target ?? "Your GPU";
  }
}

export interface SetupPillState {
  text: string;
  tone: "ok" | "sodium" | "danger";
}

/** Text and tone of the header's setup pill (spec §4.1). `blockedByModels`: see modelsBlockEveryTemplate. */
export function setupPill(s: SetupStatus | undefined, blockedByModels = false): SetupPillState | undefined {
  if (!s) return undefined;
  if (s.ffmpeg.state === "missing") return { text: "Install ffmpeg", tone: "danger" };
  if (s.gpu.state === "unreachable") return { text: "GPU offline", tone: "danger" };
  if (!s.ready.make || blockedByModels) return { text: "Finish setup", tone: "sodium" };
  return { text: `Ready · ${gpuName(s)}`, tone: "ok" };
}

export type BannerAction = "setup" | "ffmpeg" | "save-secret" | "models";

/**
 * The setup banner's one message (spec §4.1), the most blocking first, or undefined when edits can be
 * made. `blockedByModels`: see modelsBlockEveryTemplate.
 */
export function setupBanner(s: SetupStatus, blockedByModels = false): { text: string; action: BannerAction } | undefined {
  if (s.ffmpeg.state === "missing") return { text: "Install ffmpeg to decode and render edits.", action: "ffmpeg" };
  if (s.gpu.state === "env-secret") return { text: "Your Comfy Cloud key is set in this terminal only. Save it so the director can use it.", action: "save-secret" };
  if (s.gpu.state !== "ok") return { text: "Finish setup to make edits: connect a GPU. Browsing and decoding work now.", action: "setup" };
  if (s.claude.state !== "ok") return { text: "Finish setup to make edits: sign in to Claude Code. Browsing and decoding work now.", action: "setup" };
  if (!s.ready.make) return { text: s.blockers[0]?.message ?? "Finish setup to make edits. Browsing and decoding work now.", action: "setup" };
  if (blockedByModels)
    return {
      text: `Finish setup to make edits: ${s.gpu.onDemandModels ? "Comfy Cloud is missing nodes the templates need" : "your ComfyUI is missing models"}. Browsing and decoding work now.`,
      action: "models",
    };
  return undefined;
}

/** The body of the "Start now anyway?" dialog: what running two edits at once costs on this GPU. */
export function startNowCopy(s: SetupStatus | undefined): string {
  const where = s ? (gpuName(s) === "Comfy Cloud" ? "cloud" : s.gpu.where) : undefined;
  if (where === "cloud") return "Running two edits at once on Comfy Cloud shares one pot of credits. If they run out mid-edit, both pause.";
  if (where === "local") return "Both edits share this computer's GPU, so each one takes longer.";
  if (where === "remote" && s) return `Both edits share the GPU at ${gpuName(s)}, so each one takes longer.`;
  return "Both edits share your GPU, so each one takes longer.";
}

// ---------- runs ----------

/**
 * A run summary's headline split into its stage words and detail. The server sends running rows as
 * "SHOOTING STILLS · 0 of 4 stills"; the stage words are set in caps, the detail as written.
 */
export function splitHeadline(headline: string): { stage: string; detail?: string } {
  const at = headline.indexOf(" · ");
  return at < 0 ? { stage: headline } : { stage: headline.slice(0, at), detail: headline.slice(at + 3) || undefined };
}

/**
 * The take a Cut Map cell shows: the asset it was cut from (its label), else the kept take of its slot
 * (clips before stills), else any ready take of the slot.
 */
export function takeForShot(takes: readonly Take[], shot: Pick<CutMapShot, "label" | "slot"> | undefined): Take | undefined {
  if (!shot) return undefined;
  const ready = takes.filter((t) => t.state === "ready");
  const exact = shot.label ? ready.find((t) => t.asset === shot.label) : undefined;
  if (exact || !shot.slot) return exact;
  const ofSlot = ready.filter((t) => t.slot === shot.slot && t.kind !== "matte");
  const kept = (t: Take) => t.verdict?.verdict === "accept";
  return ofSlot.find((t) => kept(t) && t.kind === "clip") ?? ofSlot.find(kept) ?? ofSlot[0];
}

// ---------- the director's report ----------

export type ReportBlock = { kind: "p"; text: string } | { kind: "list"; items: { label?: string; text: string }[] };

const FLAWS = /^(known\s+)?(flaws|issues|problems)$/i;

/** Drops Markdown emphasis and code marks; keeps the words. Single underscores stay (asset ids use them). */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The director's closing report as plain paragraphs and labelled list items ("Length: 16.4 s …"), with
 * no Markdown marks left. A "Known flaws" part is dropped when the run's issues list says the same
 * thing under Known issues.
 */
export function reportBlocks(report: string, issues: readonly string[] = []): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  for (const raw of report.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line)) continue;
    const bullet = /^(?:[-*•+]|\d+[.)])\s+(.*)$/.exec(line);
    const body = bullet ? bullet[1]! : line.replace(/^#{1,6}\s+/, "");
    // "**Length:** 16.4 s", "Length: 16.4 s" (only in a list; prose keeps its colons).
    const labelled = /^\*\*([^*]{1,40}?):?\*\*:?\s*(.*)$/.exec(body) ?? (bullet ? /^([A-Z][\w '-]{0,30}):\s+(.*)$/.exec(body) : null);
    const label = labelled ? plain(labelled[1]!).replace(/:$/, "") : undefined;
    const text = plain(labelled ? labelled[2]! : body);
    if (label && FLAWS.test(label) && issues.length) continue;
    if (!text && !label) continue;
    if (bullet || label) {
      const last = blocks.at(-1);
      const item = label ? { label, text } : { text };
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
    } else blocks.push({ kind: "p", text });
  }
  return blocks;
}

// ---------- templates ----------

/**
 * The length a template shows on its tile, its page and its player: the Cut Map's (for a template with
 * an example, the example's own length), so every number on the page agrees.
 */
export const templateLength = (t: Pick<TemplateCard, "cutMap">): number => t.cutMap.durationSec;
