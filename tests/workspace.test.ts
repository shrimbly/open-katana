import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProjectSchema, Workspace } from "../src/project/workspace.js";
import { tempDir } from "./helpers/synth.js";

describe("workspace persistence", () => {
  it("survives many concurrent saves and JSON writes", async () => {
    const ws = await Workspace.create({ title: "concurrent saves", root: await tempDir("ok-ws-") });
    // A second handle on the same directory, as separate tool calls get.
    const other = await Workspace.open(ws.dir);
    await Promise.all([
      ...Array.from({ length: 40 }, () => ws.save()),
      ...Array.from({ length: 40 }, () => other.save()),
      ...Array.from({ length: 40 }, (_, i) => ws.writeJson("plan/jobs.json", [{ id: `j${i}` }])),
      ...Array.from({ length: 40 }, () => ws.setStage("analyzed")),
    ]);
    ProjectSchema.parse(JSON.parse(await readFile(ws.path("project.json"), "utf8")));
    // Writes to one file land in call order, so the last one wins.
    expect(await ws.readJson("plan/jobs.json")).toEqual([{ id: "j39" }]);
    expect([...(await readdir(ws.dir)), ...(await readdir(ws.path("plan")))].filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
