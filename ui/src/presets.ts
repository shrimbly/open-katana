import "./style.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { connect, el, sendMessage, upload } from "./bridge.js";

interface Preset {
  slug: string;
  title: string;
  description: string;
  category: string;
  hasReference: boolean;
  format?: { aspect?: string; durationSec?: number };
  inputs?: { images?: { min: number; max: number; title: string }; instructionsMaxChars?: number };
  recipe?: { look?: string; energy?: string };
}

const root = document.getElementById("app")!;
const DISCLAIMER =
  "open-katana is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Higgsfield AI. Higgsfield and Katana are trademarks of their respective owners.";
let app: App;
let presets: Preset[] = [];

const CUSTOM: Preset = {
  slug: "",
  title: "Bring your own reference",
  description: "Upload the edit you want to remix and photos of your character, product or outfit.",
  category: "custom",
  hasReference: false,
  inputs: { images: { min: 1, max: 5, title: "Photos of your subject: person, product or outfit" }, instructionsMaxChars: 2000 },
};

function gallery(): void {
  const cards = [CUSTOM, ...presets].map((p) => {
    const card = el(
      "button",
      { class: `panel card${p === CUSTOM ? " cta" : ""}` },
      el("span", { class: "title" }, p.title),
      el("span", { class: "desc" }, p.description),
      el("span", { class: "row" }, p === CUSTOM ? null : el("span", { class: "chip" }, p.category.replace("_", " ")), p.hasReference ? el("span", { class: "chip" }, "reference") : null),
    );
    card.onclick = () => form(p);
    return card;
  });
  root.replaceChildren(
    el(
      "div",
      { class: "wrap" },
      el("div", { class: "head" }, el("span", { class: "brand" }, "open-katana"), el("h1", {}, "Presets"), el("span", { class: "meta" }, "open models on your ComfyUI")),
      el("div", { class: "grid" }, ...cards),
      el("div", { class: "footnote" }, DISCLAIMER),
    ),
  );
}

function form(p: Preset): void {
  const custom = p === CUSTOM;
  const max = p.inputs?.images?.max ?? 5;
  const photos = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: "" }) as HTMLInputElement;
  const reference = el("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm" }) as HTMLInputElement;
  const notes = el("textarea", { maxlength: String(p.inputs?.instructionsMaxChars ?? 2000), placeholder: "Optional notes for the edit: what to keep, what to change" }) as HTMLTextAreaElement;
  const error = el("div", { class: "error" });
  const go = el("button", { class: "primary" }, "Start edit");
  const back = el("button", {}, "Back");
  back.onclick = gallery;
  go.onclick = async () => {
    error.textContent = "";
    const files = [...(photos.files ?? [])];
    if (files.length < (p.inputs?.images?.min ?? 1)) return void (error.textContent = "Add at least one photo.");
    if (files.length > max) return void (error.textContent = `Use at most ${max} photos.`);
    if (custom && !reference.files?.length) return void (error.textContent = "Add the reference video to remix.");
    go.setAttribute("disabled", "");
    try {
      const media: string[] = [];
      if (custom) {
        go.textContent = "Uploading reference…";
        media.push(`- reference: ${await upload(app, reference.files![0]!)}`);
      }
      for (const [i, f] of files.entries()) {
        go.textContent = `Uploading photo ${i + 1}/${files.length}…`;
        media.push(`- subject: ${await upload(app, f)}`);
      }
      const lines = [`/katana${custom ? "" : `/${p.slug}`}`, "", "MEDIA:", ...media];
      if (notes.value.trim()) lines.push("", "INPUTS:", `- instructions: ${JSON.stringify(notes.value.trim())}`);
      await sendMessage(app, lines.join("\n"));
      go.textContent = "Sent to chat";
    } catch (e) {
      error.textContent = (e as Error).message;
      go.textContent = "Start edit";
      go.removeAttribute("disabled");
    }
  };
  root.replaceChildren(
    el(
      "div",
      { class: "wrap" },
      el("div", { class: "head" }, el("span", { class: "brand" }, "open-katana"), el("h1", {}, p.title), p.format?.aspect ? el("span", { class: "meta" }, `${p.format.aspect}${p.format.durationSec ? ` · ~${p.format.durationSec} s` : ""}`) : null),
      el("div", { class: "muted" }, p.description),
      p.recipe?.energy ? el("div", { class: "meta" }, p.recipe.energy) : null,
      custom ? el("label", {}, "Reference video", reference) : null,
      el("label", {}, `${p.inputs?.images?.title ?? "Photos"} (up to ${max})`, photos),
      el("label", {}, "Instructions", notes),
      error,
      el("div", { class: "row" }, go, back),
    ),
  );
}

connect("presets", (data) => {
  presets = (data.presets as Preset[] | undefined) ?? [];
  gallery();
}).then((a) => {
  app = a;
});
