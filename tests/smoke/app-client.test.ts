// Unit tests for the app client's pure helpers (studio/src/app/copy.ts): what the header, the setup
// page, the Making-now rail, the result and the template pages say. Runs under `pnpm test`; the browser
// checks of the same screens are in app.smoke.mjs.
import { describe, expect, it } from "vitest";
import type { SetupStatus, Take } from "../../src/app/types.js";
import {
  missingProfiles,
  modelsBlockEveryTemplate,
  reportBlocks,
  setupBanner,
  setupPill,
  splitHeadline,
  startNowCopy,
  takeForShot,
  templateLength,
} from "../../studio/src/app/copy.js";
import { setupAllModelsMissing, setupModelsMissing, setupNoGpu, setupReady, templates } from "../../studio/src/app/fixtures/browse.js";

const titles = templates.map((t) => t.title);

describe("setup: missing models that block every template", () => {
  it("is not ready when no template can be made, even though the server says ready.make", () => {
    expect(setupAllModelsMissing.ready.make).toBe(true);
    expect(modelsBlockEveryTemplate(setupAllModelsMissing, titles)).toBe(true);
    expect(setupPill(setupAllModelsMissing, true)).toEqual({ text: "Finish setup", tone: "sodium" });
    expect(setupBanner(setupAllModelsMissing, true)).toEqual({
      text: "Finish setup to make edits: your ComfyUI is missing models. Browsing and decoding work now.",
      action: "models",
    });
  });

  it("stays Ready when some templates can still be made", () => {
    const some: SetupStatus = {
      ...setupAllModelsMissing,
      gpu: { ...setupAllModelsMissing.gpu, profiles: setupAllModelsMissing.gpu.profiles.map((p) => (p.neededBy ? { ...p, neededBy: titles.slice(0, 3) } : p)) },
    };
    expect(modelsBlockEveryTemplate(some, titles)).toBe(false);
    expect(setupPill(some, false)).toEqual({ text: "Ready · This computer", tone: "ok" });
    expect(setupBanner(some, false)).toBeUndefined();
  });

  it("does not guess before the template list is known, or while the GPU itself is the problem", () => {
    expect(modelsBlockEveryTemplate(setupAllModelsMissing, undefined)).toBe(false);
    expect(modelsBlockEveryTemplate(setupAllModelsMissing, [])).toBe(false);
    expect(modelsBlockEveryTemplate({ ...setupAllModelsMissing, gpu: { ...setupAllModelsMissing.gpu, state: "unreachable" } }, titles)).toBe(false);
    expect(modelsBlockEveryTemplate(setupReady, titles)).toBe(false);
  });

  it("lists only the profiles templates need once the server says which", () => {
    expect(missingProfiles(setupAllModelsMissing).map((p) => p.operation)).toEqual(["still.compose", "clip.i2v"]);
    // No neededBy anywhere (older server): every missing profile is listed.
    expect(missingProfiles(setupModelsMissing).map((p) => p.id)).toEqual(["minimax-h3-r2v"]);
  });

  it("keeps the other pill states", () => {
    expect(setupPill(setupReady)).toEqual({ text: "Ready · Comfy Cloud", tone: "ok" });
    expect(setupPill(setupNoGpu)).toEqual({ text: "Finish setup", tone: "sodium" });
    expect(setupPill(undefined)).toBeUndefined();
    expect(setupBanner(setupReady)).toBeUndefined();
  });
});

describe("Start now anyway: the cost of two edits at once on this GPU", () => {
  it("talks about shared credits only on Comfy Cloud", () => {
    expect(startNowCopy(setupReady)).toMatch(/Comfy Cloud shares one pot of credits/);
    expect(startNowCopy({ ...setupReady, gpu: { ...setupReady.gpu, kind: "comfy-cli", where: undefined } })).toMatch(/credits/);
  });

  it("says the GPU is shared on this computer or another one", () => {
    expect(startNowCopy(setupModelsMissing)).toBe("Both edits share this computer's GPU, so each one takes longer.");
    const remote: SetupStatus = { ...setupModelsMissing, gpu: { ...setupModelsMissing.gpu, where: "remote", target: "https://gpu.lan:8188" } };
    expect(startNowCopy(remote)).toBe("Both edits share the GPU at gpu.lan:8188, so each one takes longer.");
    expect(startNowCopy(undefined)).not.toMatch(/credits/);
  });
});

describe("Making now: the stage words and the detail, once each", () => {
  it("splits the server's running headline", () => {
    // summarize() in src/app/runs/reducer.ts sends running rows like this.
    expect(splitHeadline("SHOOTING STILLS · 0 of 4 stills")).toEqual({ stage: "SHOOTING STILLS", detail: "0 of 4 stills" });
    expect(splitHeadline("SHOOTING STILLS · 9 of 33 stills · picked temple-key_t2")).toEqual({ stage: "SHOOTING STILLS", detail: "9 of 33 stills · picked temple-key_t2" });
    expect(splitHeadline("GETTING READY")).toEqual({ stage: "GETTING READY" });
  });
});

describe("the director's report on the result", () => {
  // The report of a real run (r-20261017105905-eb90), shortened.
  const report =
    "The Hype Energy edit is delivered as version 1: it follows the template shot for shot.\n" +
    "- **Length:** 16.4 s at 1080×1920 and 60 fps (986 frames, 24.8 MB).\n" +
    "- **Generated:** a face crop, 10 stills, 6 moving clips and 2 cut-outs of you.\n" +
    "- **Fixes:** I swapped the wide standing shot for a still (temple-key_t2 stays).\n" +
    '- **Known flaws:** "CROWN ACCEPTED" sits small and faint at the very top of the frame.';
  const issues = ["CROWN ACCEPTED card is small and faint at the top edge over bright sky"];

  it("has no Markdown marks left and keeps the structure", () => {
    const blocks = reportBlocks(report, issues);
    expect(JSON.stringify(blocks)).not.toMatch(/\*\*|^- /);
    expect(blocks).toEqual([
      { kind: "p", text: "The Hype Energy edit is delivered as version 1: it follows the template shot for shot." },
      {
        kind: "list",
        items: [
          { label: "Length", text: "16.4 s at 1080×1920 and 60 fps (986 frames, 24.8 MB)." },
          { label: "Generated", text: "a face crop, 10 stills, 6 moving clips and 2 cut-outs of you." },
          { label: "Fixes", text: "I swapped the wide standing shot for a still (temple-key_t2 stays)." },
        ],
      },
    ]);
  });

  it("keeps Known flaws when there is no Known issues list to repeat it", () => {
    const items = reportBlocks(report, []).flatMap((b) => (b.kind === "list" ? b.items : []));
    expect(items.at(-1)).toEqual({ label: "Known flaws", text: '"CROWN ACCEPTED" sits small and faint at the very top of the frame.' });
  });

  it("leaves plain lines as paragraphs", () => {
    expect(reportBlocks("Hype Energy on a rooftop car park, 16.4 s.\nMade 1 face crop, 3 keyframes and 1 clip.")).toEqual([
      { kind: "p", text: "Hype Energy on a rooftop car park, 16.4 s." },
      { kind: "p", text: "Made 1 face crop, 3 keyframes and 1 clip." },
    ]);
    expect(reportBlocks("## Done\nIt *really* works, see `render/edl.json`.")).toEqual([
      { kind: "p", text: "Done" },
      { kind: "p", text: "It really works, see render/edl.json." },
    ]);
  });
});

describe("the result's Cut Map opens the take a shot was cut from", () => {
  const take = (asset: string, line: string, slot: string, kind: Take["kind"], verdict?: "accept" | "reject"): Take => ({
    asset,
    line,
    slot,
    kind,
    state: "ready",
    at: "2026-10-17T10:00:00.000Z",
    ...(verdict ? { verdict: { by: "director", verdict } } : {}),
  });
  const takes = [take("spin-key_t1", "spin-key", "spin", "still", "reject"), take("spin-key_t2", "spin-key", "spin", "still", "accept"), take("spin_t1", "spin", "spin", "clip", "accept"), take("spin-matte_t1", "spin-matte", "spin", "matte", "accept")];

  it("prefers the shot's own asset, then the slot's kept clip, then its kept still", () => {
    expect(takeForShot(takes, { label: "spin-key_t1", slot: "spin" })?.asset).toBe("spin-key_t1");
    expect(takeForShot(takes, { slot: "spin" })?.asset).toBe("spin_t1");
    expect(takeForShot(takes.slice(0, 2), { slot: "spin" })?.asset).toBe("spin-key_t2");
    expect(takeForShot(takes, { slot: "walk" })).toBeUndefined();
    expect(takeForShot(takes, undefined)).toBeUndefined();
  });
});

describe("one length per template", () => {
  it("shows the example's (Cut Map's) length, not the preset's target, on freestyle templates", () => {
    const cold = templates.find((t) => t.slug === "cold-stare")!;
    const t = { ...cold, format: { ...cold.format, durationSec: 10 }, cutMap: { ...cold.cutMap, durationSec: 11 } };
    expect(templateLength(t)).toBe(11);
  });
});
