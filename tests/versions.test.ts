import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/server/server.js";

const json = (rel: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", rel), "utf8"));

describe("release metadata", () => {
  it("keeps package.json, the plugin manifests and the server version in step", () => {
    const pkg = json("package.json");
    const plugin = json(".claude-plugin/plugin.json");
    const marketplace = json(".claude-plugin/marketplace.json");
    expect(plugin.version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
    if (marketplace.metadata?.version) expect(marketplace.metadata.version).toBe(pkg.version);
    for (const entry of marketplace.plugins ?? []) {
      if (entry.version) expect(entry.version).toBe(pkg.version);
    }
  });
});
