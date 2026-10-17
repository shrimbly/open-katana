import "./style.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { connect, el, type Structured } from "./bridge.js";

interface Version {
  version: number;
  uri: string;
  note?: string;
}

const root = document.getElementById("app")!;
let app: App;
let current: string | undefined;

async function load(video: HTMLVideoElement, status: HTMLElement, uri: string): Promise<void> {
  current = uri;
  status.textContent = "Loading…";
  try {
    const res = await app.readServerResource({ uri });
    const blob = (res.contents[0] as { blob?: string } | undefined)?.blob;
    if (!blob || current !== uri) return;
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    status.textContent = "";
  } catch (e) {
    status.textContent = `Preview unavailable (${(e as Error).message}). The file is saved locally.`;
  }
}

function render(data: Structured): void {
  const title = String(data.title ?? "open-katana edit");
  const uri = String(data.uri ?? "");
  const versions = (data.versions as Version[] | undefined) ?? [];
  const video = el("video", { controls: "", playsinline: "", loop: "", autoplay: "" }) as HTMLVideoElement;
  video.muted = true;
  const status = el("div", { class: "meta" });
  const download = el("button", { class: "primary" }, "Download");
  download.onclick = async () => {
    const target = current ?? uri;
    await app.downloadFile({ contents: [{ type: "resource_link", uri: target, name: `${title.replace(/[^\w-]+/g, "_")}.mp4`, mimeType: "video/mp4" }] });
  };
  const chips = el("div", { class: "row" });
  for (const v of versions) {
    const chip = el("button", { class: `chip${v.uri === uri ? " on" : ""}`, title: v.note ?? "" }, `v${v.version}`);
    chip.onclick = () => {
      chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
      chip.classList.add("on");
      void load(video, status, v.uri);
    };
    chips.append(chip);
  }
  const meta = [`v${data.version}`, data.durationSec ? `${Number(data.durationSec).toFixed(1)} s` : "", data.sizeMB ? `${data.sizeMB} MB` : ""].filter(Boolean).join(" · ");
  root.replaceChildren(
    el(
      "div",
      { class: "wrap" },
      el("div", { class: "head" }, el("span", { class: "brand" }, "open-katana"), el("h1", {}, title), el("span", { class: "meta" }, meta)),
      el("div", { class: "panel" }, video),
      el("div", { class: "row" }, download, versions.length > 1 ? chips : null, status),
      el("div", { class: "meta" }, String(data.path ?? "")),
    ),
  );
  if (uri) void load(video, status, uri);
}

connect("result", render).then((a) => {
  app = a;
});
