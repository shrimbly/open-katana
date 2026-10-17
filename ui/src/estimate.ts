import "./style.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { connect, el, sendMessage, type Structured } from "./bridge.js";

interface Job {
  line: string;
  operation: string;
  profile: string;
  takes: number;
  video: string;
  size: string;
  minutes: number;
  license?: { name: string; commercial: "yes" | "no" | "restricted" };
}

const LICENSE_BADGE: Record<string, string> = { no: "non-commercial", restricted: "restricted" };

/** Model cell: the profile, plus a badge when its licence limits commercial use. */
function model(j: Job): HTMLElement {
  const badge = LICENSE_BADGE[j.license?.commercial ?? "yes"];
  return el("td", { class: "muted" }, j.profile, badge ? el("span", { class: "badge", title: j.license?.name ?? "" }, badge) : null);
}

const root = document.getElementById("app")!;
let app: App;

function render(data: Structured): void {
  const jobs = (data.jobs as Job[] | undefined) ?? [];
  const total = Number(data.totalMinutes ?? 0);
  const budget = Number(data.budgetMinutes ?? 0);
  const warnings = (data.licenseWarnings as string[] | undefined) ?? [];
  const approve = el("button", { class: "primary" }, "Approve and generate");
  const change = el("button", {}, "Change the plan");
  approve.onclick = async () => {
    approve.setAttribute("disabled", "");
    await sendMessage(app, `Approved: generate the plan for project ${data.project} within ${Math.max(total * 1.5, total + 2).toFixed(0)} GPU minutes.`);
    approve.textContent = "Approved";
  };
  change.onclick = () => sendMessage(app, "Before generating, let's change the plan:");
  const rows = jobs.map((j) =>
    el("tr", {}, el("td", {}, j.line), el("td", {}, j.operation), model(j), el("td", {}, j.video || "still"), el("td", {}, j.minutes.toFixed(1))),
  );
  root.replaceChildren(
    el(
      "div",
      { class: "wrap" },
      el("div", { class: "head" }, el("span", { class: "brand" }, "open-katana"), el("h1", {}, "Generation estimate"), el("span", { class: "meta" }, String(data.backend ?? ""))),
      jobs.length
        ? el(
            "div",
            { class: "panel" },
            el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Line"), el("th", {}, "Operation"), el("th", {}, "Model"), el("th", {}, "Video"), el("th", {}, "GPU min"))), el("tbody", {}, ...rows)),
          )
        : el("div", { class: "muted" }, "Nothing to generate: the edit uses footage, stills and graphics only."),
      el("div", { class: "row" }, el("span", { class: "total" }, `${total.toFixed(1)} GPU min`), el("span", { class: "meta" }, `project budget ${budget} min · analysis, editing and text are free`)),
      warnings.length ? el("div", { class: "panel warn" }, el("strong", {}, "Licence notes"), ...warnings.map((w) => el("div", {}, w))) : null,
      el("div", { class: "row" }, approve, change),
    ),
  );
}

connect("estimate", render).then((a) => {
  app = a;
});
