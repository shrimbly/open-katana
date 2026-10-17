#!/usr/bin/env node
// Browser smoke test for the app (spec §14.4): `pnpm test:smoke`. Not part of `pnpm test`.
//
// Starts `open-katana app` on a temp OPEN_KATANA_HOME with the fake director (tests/fixtures/fake-claude.mjs)
// and a fake ComfyUI, drives the system Chrome over the DevTools protocol through the template path, the
// result, the editor and a decode, then checks tab order, phone widths and accessible names. Steps 8–12
// check client regressions (tile menu focus, takes after a run, Making now, Start now copy, setup banner
// and pill without layout shift), partly against the mock fixtures (?mock=1). Screenshots go to
// tests/smoke/out/. Skips (exit 0) when Chrome is missing.
//
// The client is built into the temp home and served from there (OPEN_KATANA_UI_DIR), so dist/ and any
// studio serving it are left alone.
//
// Env: SMOKE_PORT and SMOKE_COMFY_PORT (default 0 = any free port) · SMOKE_NO_BUILD=1 to serve dist/studio-ui as built ·
// FAKE_CLAUDE_SCENARIO (a scenario name, path or JSON; default template-success) · FAKE_CLAUDE_SPEED (default 20) ·
// CHROME_PATH · SMOKE_KEEP=1 keeps the temp home.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./cdp.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, "tests", "smoke", "out");
const chrome = findChrome();
if (!chrome) {
  console.log("smoke: skipped (no Chrome found; set CHROME_PATH to run it)");
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, ".gitignore"), "*\n");

const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
let failed = false;
/** Set once the browser is up: screenshots the failing screen and returns what its toasts say. */
let onFail;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed = true;
    const extra = (await onFail?.().catch(() => "")) ?? "";
    log(`  FAIL ${name}\n       ${`${String(e.message ?? e)}${extra}`.replace(/\n/g, "\n       ")}`);
    throw e;
  }
}

// ---------- fixtures: media, home, fake ComfyUI ----------

const home = mkdtempSync(join(tmpdir(), "katana-smoke-home-"));
const media = join(home, "smoke-media");
mkdirSync(media);
const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const PHOTO = join(media, "me-front.png");
const TRACK = join(media, "track-128.wav");
const CLIP = join(media, "six-shots.mp4");
const CLIP_CUTS = 5;
const RESULT = join(media, "delivered.mp4");
ffmpeg(["-f", "lavfi", "-i", "gradients=s=1200x1600:c0=0x6b5a44:c1=0xd8cfc0:seed=3", "-frames:v", "1", PHOTO]);
// 128 BPM clicks, 30 s.
ffmpeg(["-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,0.46875)\\,0.03)\\,sin(2*PI*1000*t)\\,0):s=44100:d=30", TRACK]);
// Six flat-colour shots of 1 s each (five hard cuts) with a beat under them.
const colours = ["0x8b2f2f", "0x2f5f8b", "0xd8cfc0", "0x2f8b4a", "0x1a1c1f", "0xf2a33a"];
ffmpeg([
  ...colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=540x960:r=30:d=1`]),
  "-f",
  "lavfi",
  "-i",
  "aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,sin(2*PI*880*t)\\,0):s=44100:d=6",
  "-filter_complex",
  `${colours.map((_, i) => `[${i}:v]`).join("")}concat=n=${colours.length}:v=1:a=0,noise=alls=6:allf=t[v]`,
  "-map",
  "[v]",
  "-map",
  `${colours.length}:a`,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  CLIP,
]);

// What the fake director "delivers": a short playable 9:16 clip with sound.
ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", RESULT]);

/**
 * The fake ComfyUI from the unit tests (tests/helpers/fake-comfy.ts: a complete object_info, prompts that
 * finish, queue delete and interrupt), run in a child process under tsx.
 */
const comfyProc = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(join(ROOT, "tests", "helpers", "fake-comfy.ts"))}); const f = await m.startFakeComfy({ completeAfterMs: 300, port: ${Number(process.env.SMOKE_COMFY_PORT ?? 0)} }); console.log("FAKE_COMFY " + f.url);`,
  ],
  { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
);
cleanups.push(() => comfyProc.kill("SIGTERM"));
const comfyUrl = await new Promise((resolve, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error(`the fake ComfyUI didn't start: ${out}`)), 20_000);
  comfyProc.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/FAKE_COMFY (\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  comfyProc.on("exit", (code) => reject(new Error(`the fake ComfyUI exited (${code}): ${out}`)));
});
writeFileSync(join(home, "config.json"), JSON.stringify({ backend: { kind: "http", url: comfyUrl } }, null, 2), { mode: 0o600 });

// ---------- the app ----------

const uiDir = process.env.SMOKE_NO_BUILD === "1" ? join(ROOT, "dist", "studio-ui") : join(home, "studio-ui");
if (process.env.SMOKE_NO_BUILD !== "1") {
  log("smoke: building the client (vite)…");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "studio/vite.config.ts", "--outDir", uiDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(join(uiDir, "index.html"))) {
  log(`smoke: ${uiDir} has no index.html. Run pnpm build (or drop SMOKE_NO_BUILD).`);
  process.exit(1);
}

const env = {
  ...process.env,
  OPEN_KATANA_HOME: home,
  OPEN_KATANA_UI_DIR: uiDir,
  OPEN_KATANA_CLAUDE: join(ROOT, "tests", "fixtures", "fake-claude.mjs"),
  FAKE_CLAUDE_SCENARIO: process.env.FAKE_CLAUDE_SCENARIO ?? "template-success",
  FAKE_CLAUDE_SPEED: process.env.FAKE_CLAUDE_SPEED ?? "20",
  FAKE_CLAUDE_VIDEO: RESULT,
};
delete env.COMFYUI_URL;
delete env.OPEN_KATANA_BACKEND;
delete env.COMFY_CLOUD_API_KEY;
const server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), "app", "--no-open", "--port", process.env.SMOKE_PORT ?? "0"], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
cleanups.push(() => server.kill("SIGTERM"));
let serverLog = "";
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the app didn't start:\n${serverLog}`)), 30_000);
  const read = (d) => {
    serverLog += d;
    const m = serverLog.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${m[1]}`);
    }
  };
  server.stdout.on("data", read);
  server.stderr.on("data", read);
  server.on("exit", (code) => reject(new Error(`the app exited (${code}):\n${serverLog}`)));
});
log(`smoke: app on ${base}, home ${home}`);
// A fresh home downloads the UI faces at start; wait for them so the first page has no 404s.
for (let i = 0; i < 120; i++) {
  const ok = await Promise.all(["Archivo_wdth,wght_.ttf", "JetBrainsMono_wght_.ttf"].map((f) => fetch(`${base}/fonts/${f}`, { method: "HEAD" }).then((r) => r.ok, () => false)));
  if (ok.every(Boolean)) break;
  await sleep(500);
}

// ---------- the browser ----------

const page = await launch({ width: 1440, height: 900, chrome });
cleanups.push(() => page.close());
const IGNORED_ERRORS = [/favicon\.ico/];
const realErrors = () => page.errors.filter((e) => !IGNORED_ERRORS.some((re) => re.test(e)));
const shot = (name) => page.screenshot(join(OUT, `${name}.png`));
onFail = async () => {
  await shot("failed");
  const said = await page.eval(`[...document.querySelectorAll(".kt-toast, [role=alert]")].map((t) => t.textContent.trim()).join(" | ")`);
  return `\non screen (${await page.eval("location.pathname")}): ${said || "no toasts"}; see out/failed.png${realErrors().length ? `\nconsole: ${realErrors().join("\n")}` : ""}`;
};
/** Finds the first element matching `selector` whose text matches `re` (page-side helper as a JS string). */
const byText = (selector, re) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${re}.test(el.textContent ?? ""))`;
const fileInput = (kind) => `js:document.querySelector('input[type=file][accept*="${kind}"]')`;

let project;
let decodeProject;

try {
  log("smoke: steps");

  await step("1. gallery shows 7 templates, no console errors", async () => {
    await page.goto(`${base}/`);
    const n = await page.waitFor(`(() => { const s = new Set([...document.querySelectorAll('a[href^="/t/"]')].map((a) => a.getAttribute("href"))); return s.size >= 7 && s.size; })()`, { what: "7 template tiles" });
    if (n !== 7) throw new Error(`expected 7 templates, found ${n}`);
    await sleep(500);
    if (realErrors().length) throw new Error(`console errors:\n${realErrors().join("\n")}`);
    await shot("home-1440");
  });

  await step("2. Hype Energy: photo and track in, words in League Gothic, consent, receipt numbers", async () => {
    await page.click('a[href="/t/hype-energy"]');
    await page.waitFor(`location.pathname === "/t/hype-energy" && ${fileInput("image").slice(3)}`, { what: "the photo input" });
    await page.setFiles(fileInput("image"), [PHOTO]);
    await page.waitFor(`[...document.querySelectorAll("input")].some((i) => i.value === "NOTHING NEW")`, { timeout: 15_000, what: 'the "NOTHING NEW" field' });
    await page.waitFor(
      `(() => { const i = [...document.querySelectorAll("input")].find((i) => i.value === "NOTHING NEW"); return i && /League Gothic/.test(getComputedStyle(i).fontFamily) && document.fonts.check('18px "League Gothic"'); })()`,
      { timeout: 15_000, what: "NOTHING NEW set in League Gothic" },
    );
    // Templates that ship a track start on it; the smoke brings its own.
    const ownTrack = `${byText("label.kt-radio", "/My own track/")}?.querySelector("input")`;
    if (await page.eval(`Boolean(${ownTrack})`)) {
      await page.click(`js:${byText("label.kt-radio", "/My own track/")}`);
      await page.waitFor(`${ownTrack}.checked`, { timeout: 3000, what: "My own track chosen" });
    }
    await page.setFiles(fileInput("audio"), [TRACK]);
    await page.click(`js:${byText("label", "/This is me/")}`);
    await page.waitFor(`${byText("label", "/This is me/")}?.querySelector("input")?.checked`, { what: "the consent tick" });
    try {
      await page.waitFor(`/Your track: \\d+ BPM/.test(document.body.innerText)`, { timeout: 20_000, what: "the track analysed (Your track: n BPM)" });
    } catch (e) {
      throw new Error(`${e.message}\nthe music field reads: ${JSON.stringify(await page.eval(`document.querySelector(".kt-track")?.innerText ?? "(no music field)"`).catch(() => ""))}`);
    }
    await page.waitFor(`/\\d+–\\d+ min on /.test(document.body.innerText) && /cap \\$\\d+/.test(document.body.innerText)`, { timeout: 15_000, what: "receipt numbers" });
    await shot("template-ready-1440");
  });

  await step("3. Make my edit (licence ticked): progress shows phases; reduced motion: no flash, no autoplay", async () => {
    await page.reducedMotion(true);
    await page.eval(`window.__flashes = 0; new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains("kt-arrival") && window.__flashes++))).observe(document.body, { childList: true }); true`);
    const makeReady = `(() => { const b = ${byText("button", "/make my edit/i")}; return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; })()`;
    try {
      await page.waitFor(makeReady, { timeout: 20_000, what: "Make my edit enabled" });
    } catch (e) {
      const why = await page.eval(`[...document.querySelectorAll("[role=status], .kt-make-why")].map((n) => n.textContent.trim()).filter(Boolean).join(" | ")`).catch(() => "");
      throw new Error(`${e.message}\nthe page says: ${why}`);
    }
    await page.click(`js:${byText("button", "/make my edit/i")}`);
    const dialog = await page.waitFor(`location.pathname.startsWith("/p/") ? "page" : document.querySelector('[role=dialog][aria-modal=true]') ? "dialog" : ""`, { timeout: 15_000, what: "the approve dialog or the progress page" });
    if (dialog === "dialog") {
      await sleep(400); // the dialog fades in
      // Esc on the licence Details popover closes the popover, not the dialog (the layer stack in ui.tsx).
      const details = byText("[role=dialog][aria-modal=true] button", "/^Details$/");
      if (await page.eval(`Boolean(${details})`)) {
        await page.click(`js:${details}`);
        await page.waitFor(`document.querySelector("[role=dialog][aria-modal=true] .kt-popover")`, { timeout: 3000, what: "the Details popover" });
        await page.key("Escape");
        await page.waitFor(`!document.querySelector(".kt-popover")`, { timeout: 3000, what: "the popover closed by Esc" });
        await sleep(200);
        if (!(await page.eval(`Boolean(document.querySelector("[role=dialog][aria-modal=true]"))`))) throw new Error("Esc on the Details popover closed the approve dialog too");
        if (!(await page.eval(`document.activeElement?.textContent === "Details"`))) throw new Error("focus didn't go back to Details after Esc");
      }
      const tick = `${byText("[role=dialog] label", "/within their licences/")}?.querySelector("input")`;
      await page.click(`js:${byText("[role=dialog] label", "/within their licences/")}`);
      await page.waitFor(`${tick}?.checked`, { timeout: 3000, what: "the licence tick" });
      await page.click(`js:${byText("[role=dialog] button", "/make my edit/i")}`);
    }
    await page.waitFor(`location.pathname.startsWith("/p/")`, { timeout: 15_000, what: "the progress page" });
    project = await page.eval(`decodeURIComponent(location.pathname.split("/")[2])`);
    await page.waitFor(`document.querySelector(".phase-rail .phase") || document.querySelector(".result")`, { timeout: 20_000, what: "the phase rail" });
    await shot("progress-1440");
    await page.waitFor(`document.querySelector(".result video")`, { timeout: 180_000, what: "the result (fake director done)" });
    await sleep(800);
    const flashes = await page.eval("window.__flashes");
    if (flashes) throw new Error(`${flashes} arrival flash(es) under reduced motion`);
    const playing = await page.eval(`[...document.querySelectorAll("video")].filter((v) => !v.paused).length`);
    if (playing) throw new Error(`${playing} video(s) autoplaying under reduced motion`);
    await shot("result-reduced-1440");
  });

  await step("4. result plays; Open in editor loads the editor without the lock banner", async () => {
    await page.reducedMotion(false);
    await page.goto(`${base}/p/${encodeURIComponent(project)}`);
    await page.waitFor(`(() => { const v = document.querySelector(".result video"); return v && !v.paused && v.currentTime > 0.2; })()`, { timeout: 15_000, what: "the result playing" });
    await shot("result-1440");
    // The takes stay reachable after the run (spec D28, §4.10): Show all, then a take opens the lightbox.
    if (await page.eval(`Boolean(document.querySelector(".result-takes"))`)) {
      await page.click(`js:${byText(".result-takes button", "/^Show all/")}`);
      await page.waitFor(`document.querySelector("#result-take-grid button.take")`, { timeout: 3000, what: "the result's take tiles" });
      await page.click("#result-take-grid button.take");
      await page.waitFor(`${byText(".lightbox button", "/use this take/i")}`, { timeout: 3000, what: "the take lightbox from the result" });
      await page.key("Escape");
      await page.waitFor(`!document.querySelector(".lightbox")`, { timeout: 3000, what: "the lightbox closed" });
    } else throw new Error("the result has no Takes section (the fake director made takes)");
    await page.click(`js:${byText(".result a", "/open in editor/i")}`);
    await page.waitFor(`location.pathname.startsWith("/edit/") && window.studio && document.querySelector(".topbar")`, { timeout: 20_000, what: "the editor" });
    await sleep(800);
    if (await page.eval(`Boolean(document.querySelector(".lock-banner"))`)) throw new Error("the editor shows the lock banner after the run");
    await shot("editor-1440");
  });

  await step("5. decode the synthetic clip: the stat row shows the cut count within 10 s", async () => {
    await page.goto(`${base}/`);
    await page.waitFor(fileInput("video").slice(3), { what: "the decode drop box" });
    const t0 = Date.now();
    await page.setFiles(fileInput("video"), [CLIP]);
    await page.waitFor(`location.pathname.startsWith("/decode/")`, { timeout: 10_000, what: "the decode page" });
    decodeProject = await page.eval(`decodeURIComponent(location.pathname.split("/")[2])`);
    const left = Math.max(1000, 10_000 - (Date.now() - t0));
    // The numbers count up for 300 ms when they arrive, so wait for the final value.
    const statText = `(document.querySelector(".stat-row")?.textContent ?? "").replace(/\\s+/g, " ")`;
    try {
      await page.waitFor(`/(^|\\D)${CLIP_CUTS}\\s*CUTS/.test(${statText})`, { timeout: left, what: `${CLIP_CUTS} CUTS in the stat row` });
    } catch (e) {
      throw new Error(`${e.message}\nthe stat row reads "${await page.eval(statText).catch(() => "")}"`);
    }
    await sleep(600);
    await shot("decode-1440");
  });

  await step("6. tab order on the template page: photo, consent, fields, track, receipt, button; focus ring visible", async () => {
    await page.goto(`${base}/t/hype-energy`);
    await page.waitFor(fileInput("image").slice(3), { what: "the photo input" });
    await page.setFiles(fileInput("image"), [PHOTO]);
    await page.waitFor(`[...document.querySelectorAll("input")].some((i) => i.value === "NOTHING NEW")`, { timeout: 15_000, what: "the brief" });
    await page.waitFor(`/\\d+–\\d+ min on /.test(document.body.innerText)`, { timeout: 15_000, what: "the receipt" });
    // Mark the anchors, start just before the photo controls, then Tab through and record what gets focus.
    const marked = await page.eval(`(() => {
      const mark = (el, name) => el && el.setAttribute("data-smoke", name);
      const consent = ${byText("label", "/This is me/")}?.querySelector("input");
      const imageInput = document.querySelector('input[type=file][accept*="image"]');
      const audioInput = document.querySelector('input[type=file][accept*="audio"]');
      // Containers, so any focusable control inside them counts (the nearest mark wins).
      const photo = imageInput?.closest(".kt-step, section") ?? imageInput?.parentElement;
      const field = [...document.querySelectorAll("input")].find((i) => i.value === "NOTHING NEW");
      const track = audioInput?.closest("[class*=track]") ?? audioInput?.parentElement;
      const button = ${byText("button", "/make my edit/i")};
      const receipt = [...document.querySelectorAll("section, div")].find((el) => /^\\s*3?\\s*BUDGET/i.test(el.innerText ?? "") && el.querySelector("button, input"));
      mark(photo, "photo"); mark(consent, "consent"); mark(field, "fields"); mark(track, "track"); mark(receipt, "receipt"); mark(button, "button");
      document.activeElement?.blur();
      const before = photo;
      const start = document.createElement("button");
      start.textContent = "smoke start";
      before.parentElement.insertBefore(start, before);
      start.focus();
      return [photo, consent, field, track, receipt, button].map((e) => Boolean(e));
    })()`);
    if (marked.includes(false)) throw new Error(`anchors not found (photo, consent, fields, track, receipt, button): ${JSON.stringify(marked)}`);
    const seen = [];
    let ring;
    for (let i = 0; i < 90 && !seen.includes("button"); i++) {
      await page.key("Tab");
      const r = await page.eval(`(() => {
        const a = document.activeElement;
        const tag = a?.closest("[data-smoke]")?.getAttribute("data-smoke");
        const s = a && getComputedStyle(a);
        return { tag, ring: s ? (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow && s.boxShadow !== "none") : false };
      })()`);
      if (r.tag && !seen.includes(r.tag)) seen.push(r.tag);
      if (r.tag === "button") ring = r.ring;
    }
    const want = ["photo", "consent", "fields", "track", "receipt", "button"];
    if (JSON.stringify(seen) !== JSON.stringify(want)) throw new Error(`tab order was ${seen.join(", ")}; want ${want.join(", ")}`);
    if (!ring) throw new Error("Make my edit has no visible focus ring when focused from the keyboard");
  });

  await step("7. 1440×900 and 390×844: no horizontal page scroll; every button has an accessible name", async () => {
    const screens = ["/", "/t/hype-energy", `/p/${encodeURIComponent(project)}`, `/decode/${encodeURIComponent(decodeProject)}`, "/edits", "/setup", "/settings"];
    const problems = [];
    for (const [w, h] of [
      [1440, 900],
      [390, 844],
    ]) {
      await page.viewport(w, h, w < 760);
      for (const path of screens) {
        const t0 = Date.now();
        await page.goto(`${base}${path}`, { wait: "domcontentloaded" });
        await sleep(1500);
        const ms = Date.now() - t0;
        if (ms > 6000) log(`       (slow: ${path} at ${w} took ${(ms / 1000).toFixed(1)} s)`);
        const r = await page.eval(`(() => ({
          scroll: document.documentElement.scrollWidth,
          inner: innerWidth,
          unnamed: [...document.querySelectorAll("button, [role=button]")].filter((b) => {
            const label = b.getAttribute("aria-label") || (b.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join("") || b.textContent || [...b.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label")).join(" ") || b.getAttribute("title") || "";
            return !label.trim();
          }).map((b) => b.outerHTML.slice(0, 120)),
        }))()`);
        if (r.scroll > r.inner) problems.push(`${path} at ${w}: page scrolls sideways (${r.scroll} > ${r.inner})`);
        for (const b of r.unnamed) problems.push(`${path} at ${w}: button without a name: ${b}`);
        await shot(`${path === "/" ? "home" : path.split("/")[1]}-${w}`);
      }
    }
    if (problems.length) throw new Error(problems.join("\n"));
  });

  await page.viewport(1440, 900);
  const focused = `(() => { const a = document.activeElement; return a ? (a.getAttribute("role") ?? "") + "|" + a.className + "|" + a.tagName : ""; })()`;

  await step("8. /edits tile menu: Esc and Tab close it and give focus back to ⋯", async () => {
    await page.goto(`${base}/edits`);
    await page.waitFor(`document.querySelector(".tile-menu-btn")`, { what: "a tile's ⋯ button" });
    await page.eval(`document.querySelector(".tile-menu-btn").focus(); true`);
    await page.key("Enter");
    await page.waitFor(`document.activeElement?.getAttribute("role") === "menuitem"`, { timeout: 3000, what: "focus on the first menu item" });
    await page.key("ArrowDown");
    await page.key("Escape");
    await page.waitFor(`!document.querySelector("[role=menu]")`, { timeout: 3000, what: "the menu closed by Esc" });
    if (!(await page.eval(`document.activeElement?.classList.contains("tile-menu-btn")`))) throw new Error(`after Esc focus is on ${await page.eval(focused)}, not ⋯`);
    await page.key("Enter");
    await page.waitFor(`document.activeElement?.getAttribute("role") === "menuitem"`, { timeout: 3000, what: "the menu open again" });
    await page.key("Tab");
    await page.waitFor(`!document.querySelector("[role=menu]")`, { timeout: 3000, what: "the menu closed by Tab" });
    const at = await page.eval(focused);
    if (/BODY$/.test(at) || /^menuitem/.test(at)) throw new Error(`after Tab focus is on ${at}`);
  });

  // The rest runs against the mock fixtures (?mock=1, remembered for the tab until ?mock=0).
  const mockProject = "20261017-hype-energy-rooftop-a1b2";

  await step("9. result (mock): the takes open the lightbox, Use this take puts the pick in the edit; the report is plain text", async () => {
    await page.goto(`${base}/p/${mockProject}?mock=1&setup=ready`);
    await page.waitFor(`document.querySelector(".result-takes")`, { timeout: 10_000, what: "the result's Takes section" });
    const report = await page.eval(`document.querySelector(".director-voice")?.innerText ?? ""`);
    if (/\*\*|^\s*- /m.test(report)) throw new Error(`the director's report shows Markdown: ${JSON.stringify(report)}`);
    if (!(await page.eval(`document.querySelectorAll(".director-voice .report-list li").length >= 2`))) throw new Error("the report's bullets aren't a list");
    if (/known flaws/i.test(report)) throw new Error("the report repeats Known flaws next to Known issues");
    await page.click(`js:${byText(".result-takes button", "/^Show all/")}`);
    await page.waitFor(`document.querySelector("#result-take-grid button.take")`, { timeout: 3000, what: "the take tiles" });
    await page.eval(`document.querySelector("#result-take-grid button.take").focus(); true`);
    await page.key("Enter");
    await page.waitFor(`document.querySelector(".lightbox")`, { timeout: 3000, what: "the lightbox" });
    await page.key("Escape");
    await page.waitFor(`!document.querySelector(".lightbox") && document.activeElement?.matches("#result-take-grid button.take")`, { timeout: 3000, what: "the lightbox closed, focus back on the tile" });
    await page.key("Enter");
    await page.waitFor(`${byText(".lightbox button", "/use this take/i")}`, { timeout: 3000, what: "Use this take" });
    await page.click(`js:${byText(".lightbox button", "/use this take/i")}`);
    await page.waitFor(`/Your pick is in the edit\./.test(document.querySelector(".kt-toasts")?.textContent ?? "") && ${byText(".kt-toast button", "/update video/i")}`, {
      timeout: 5000,
      what: 'the toast "Your pick is in the edit." with Update video',
    });
    // Enter on a Cut Map cell opens that shot's take.
    await page.eval(`document.querySelector(".result-map [role=slider]").focus(); true`);
    await page.key("Home");
    await page.key("Enter");
    await page.waitFor(`document.querySelector(".lightbox")`, { timeout: 3000, what: "the lightbox from the Cut Map (Home, Enter)" });
    await page.key("Escape");
    await shot("result-takes-mock-1440");
  });

  await step("10. Making now (mock): the stage detail shows once", async () => {
    await page.goto(`${base}/?mock=1`);
    const row = `document.querySelector(".kt-now-row:not(.needs):not(.queued) .kt-now-line")`;
    await page.waitFor(`${row}?.querySelector(".kt-now-detail")`, { timeout: 5000, what: "a running row with its detail" });
    const r = await page.eval(`(() => { const l = ${row}; const d = l.querySelector(".kt-now-detail").textContent.replace(/^ · /, ""); return { line: l.textContent, detail: d }; })()`);
    const times = r.line.split(r.detail).length - 1;
    if (times !== 1) throw new Error(`the row reads "${r.line}": the detail "${r.detail}" shows ${times} times`);
  });

  await step("11. Start now anyway (mock, this computer's GPU): the dialog talks about the GPU, not Comfy Cloud credits", async () => {
    await page.goto(`${base}/p/${mockProject}?mock=1&fixture=queued&setup=models`);
    await page.waitFor(byText("button", "/start now anyway/i"), { timeout: 5000, what: "Start now anyway" });
    await page.waitFor(`/This computer/.test(document.querySelector(".kt-pill")?.textContent ?? "")`, { timeout: 5000, what: "the local GPU in the pill" });
    await page.click(`js:${byText("button", "/start now anyway/i")}`);
    const text = await page.waitFor(`document.querySelector(".kt-dialog .kt-dialog-body")?.textContent`, { timeout: 3000, what: "the Start now dialog" });
    if (/credits|Comfy Cloud/.test(text) || !/this computer's GPU/.test(text)) throw new Error(`the dialog says: ${text}`);
    await page.key("Escape");
  });

  await step("12. setup (mock): the pill keeps its place, the banner never pushes the page down; all models missing reads as such", async () => {
    // Layout shifts of the page itself (the banner's 40 px push), from navigation start.
    const shifts = `new Promise((done) => new PerformanceObserver((l, o) => { o.disconnect(); done(l.getEntries().flatMap((e) => (e.sources ?? []).filter((s) => s.node?.matches?.("main") && s.currentRect.y - s.previousRect.y > 20).map((s) => s.previousRect.y + "→" + s.currentRect.y))); }).observe({ type: "layout-shift", buffered: true }))`;
    const setupShifts = async () => (await Promise.race([page.eval(shifts), sleep(1500).then(() => [])])) ?? [];
    await page.goto(`${base}/settings?mock=1&setup=nogpu`, { wait: "domcontentloaded" });
    await page.eval(`(localStorage.removeItem("katana-setup-mock"), true)`);
    // First visit: nothing remembered. The pill is there from the start; the late banner floats over the page.
    await page.goto(`${base}/?mock=1&setup=nogpu`, { wait: "domcontentloaded" });
    if (!(await page.eval(`Boolean(document.querySelector(".kt-pill"))`))) throw new Error("no setup pill before the first check answered");
    await page.waitFor(`document.querySelector(".kt-banner")`, { timeout: 5000, what: "the setup banner" });
    if (!(await page.eval(`document.querySelector(".kt-banner").classList.contains("floating")`))) throw new Error("a banner that arrived late sits in the page flow");
    let moved = await setupShifts();
    if (moved.length) throw new Error(`the page moved down when the banner arrived: ${moved.join(", ")}`);
    // Second visit: remembered, so the banner is in the flow from the first paint and nothing moves.
    await page.goto(`${base}/?mock=1&setup=nogpu`, { wait: "domcontentloaded" });
    if (!(await page.eval(`Boolean(document.querySelector(".kt-banner:not(.floating)"))`))) throw new Error("the remembered banner wasn't drawn with the page");
    await sleep(800);
    moved = await setupShifts();
    if (moved.length) throw new Error(`the page moved down on a later visit: ${moved.join(", ")}`);
    // Every template blocked by missing models: the pill, the banner and the setup page say so.
    await page.goto(`${base}/setup?mock=1&setup=allmodels`);
    await page.waitFor(`/Missing for every template\./.test(document.querySelector(".kt-missing")?.textContent ?? "")`, { timeout: 5000, what: '"Missing for every template."' });
    const gpu = await page.eval(`document.querySelector("#gpu .kt-setup-status")?.textContent ?? ""`);
    if (!/Missing models/.test(gpu)) throw new Error(`the GPU row says "${gpu}"`);
    const pill = await page.eval(`document.querySelector(".kt-pill")?.textContent ?? ""`);
    if (!/Finish setup/.test(pill)) throw new Error(`the pill says "${pill}" with no template makeable`);
    await shot("setup-allmodels-1440");
    // Leave the mock for anything after this.
    await page.goto(`${base}/settings?mock=0&setup=ready&fixture=`, { wait: "domcontentloaded" });
  });

  log(`smoke: passed. Screenshots in ${OUT}`);
} catch {
  log(`smoke: FAILED. Screenshots so far in ${OUT}; server output:\n${serverLog.split("\n").slice(-25).join("\n")}`);
} finally {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      // Best effort.
    }
  }
  await sleep(300);
  if (process.env.SMOKE_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
