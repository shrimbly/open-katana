import { App } from "@modelcontextprotocol/ext-apps";

export type Structured = Record<string, unknown>;

/** Connects a widget to its host, applies the host theme and delivers each tool result's structured content. */
export async function connect(name: string, onResult: (data: Structured) => void): Promise<App> {
  const app = new App({ name: `open-katana ${name}`, version: __VERSION__ });
  app.ontoolresult = (params) => {
    const data = (params as { structuredContent?: Structured }).structuredContent;
    if (data) onResult(data);
  };
  app.onhostcontextchanged = () => applyTheme(app);
  await app.connect();
  applyTheme(app);
  app.setupSizeChangedNotifications();
  return app;
}

function applyTheme(app: App): void {
  const ctx = app.getHostContext();
  const root = document.documentElement;
  root.dataset.theme = ctx?.theme === "light" ? "light" : "dark";
  const vars = (ctx?.styles as { variables?: Record<string, string> } | undefined)?.variables ?? {};
  for (const [k, v] of Object.entries(vars)) if (k.startsWith("--")) root.style.setProperty(k, v);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

export async function sendMessage(app: App, text: string): Promise<void> {
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
}

const CHUNK = 1024 * 1024;

/** Uploads a picked file to the server in base64 chunks and returns its local path there. */
export async function upload(app: App, file: File, onProgress?: (share: number) => void): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let uploadId: string | undefined;
  for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK) {
    const part = bytes.subarray(offset, offset + CHUNK);
    let bin = "";
    for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]!);
    const final = offset + CHUNK >= bytes.length;
    const res = await app.callServerTool({ name: "katana_upload", arguments: { name: file.name, data: btoa(bin), uploadId, final } });
    const sc = res.structuredContent as { uploadId?: string; path?: string } | undefined;
    if (res.isError || !sc) throw new Error("Upload failed");
    uploadId = sc.uploadId;
    onProgress?.(Math.min(1, (offset + CHUNK) / Math.max(1, bytes.length)));
    if (final) return sc.path!;
  }
  throw new Error("Upload produced no file");
}
