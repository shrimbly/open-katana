import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "../../dist/dev");
// emptyOutDir stays off so the generated sample.mp4 survives rebuilds.
await build({ configFile: false, root, logLevel: "warn", plugins: [viteSingleFile()], build: { target: "es2022", outDir, emptyOutDir: false, rollupOptions: { input: resolve(root, "host.html") } } });

// The result widget plays ./sample.mp4: synthesise a 3 s vertical test pattern with a tone if there is none.
const sample = resolve(outDir, "sample.mp4");
if (!existsSync(sample)) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", sample], { stdio: "inherit" });
  if (r.status !== 0) console.warn(`Could not create ${sample} with ffmpeg; put any short MP4 there to preview the result widget.`);
}
