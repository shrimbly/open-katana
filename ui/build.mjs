// Builds each widget into one self-contained HTML file in dist/ui (MCP Apps resources must be single documents).
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(root, "../package.json"), "utf8"));
for (const name of ["result", "presets", "estimate"]) {
  await build({
    configFile: false,
    root,
    logLevel: "warn",
    plugins: [viteSingleFile()],
    define: { __VERSION__: JSON.stringify(version) },
    build: {
      outDir: resolve(root, "../dist/ui"),
      emptyOutDir: false,
      rollupOptions: { input: resolve(root, `${name}.html`) },
    },
  });
}
