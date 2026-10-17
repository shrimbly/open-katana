// Development host: renders one widget with sample tool results, the way Claude Desktop would.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import samples from "./samples.json" with { type: "json" };

const name = new URLSearchParams(location.search).get("w") ?? "result";
const theme = new URLSearchParams(location.search).get("theme") ?? "dark";
const log = (m: string) => (document.getElementById("log")!.textContent += `${m}\n`);
const iframe = document.getElementById("app") as HTMLIFrameElement;
iframe.srcdoc = await (await fetch(`../ui/${name}.html`)).text();
await new Promise((r) => (iframe.onload = r));

const bridge = new AppBridge(null, { name: "dev-host", version: "0.0.0" }, { openLinks: {}, serverTools: {}, serverResources: {}, downloadFile: {} } as never, {
  hostContext: { theme, platform: "desktop" },
} as never);
bridge.oninitialized = () => {
  log(`initialized ${name}`);
  void bridge.sendToolResult({ content: [], structuredContent: (samples as Record<string, unknown>)[name] } as never);
};
bridge.onreadresource = async ({ uri }) => {
  log(`read ${uri}`);
  const bytes = new Uint8Array(await (await fetch("./sample.mp4")).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { contents: [{ uri, mimeType: "video/mp4", blob: btoa(bin) }] };
};
bridge.onmessage = async (p) => {
  log(`message: ${JSON.stringify(p.content)}`);
  return {};
};
bridge.ondownloadfile = async (p) => {
  log(`download: ${JSON.stringify(p.contents)}`);
  return {};
};
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
