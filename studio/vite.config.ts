import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig, type ProxyOptions } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [preact()],
  build: { outDir: fileURLToPath(new URL("../dist/studio-ui", import.meta.url)), emptyOutDir: true, target: "es2022" },
  // Dev server: proxy the API to a running `open-katana studio`, presenting as the editor itself.
  server: {
    proxy: Object.fromEntries(
      ["/api", "/media", "/fonts"].map((path) => [
        path,
        { target: "http://127.0.0.1:4310", changeOrigin: true, configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")) } satisfies ProxyOptions,
      ]),
    ),
  },
});
