// A small Chrome DevTools Protocol driver for the browser smoke test (spec §14.4): headless system Chrome,
// one page, evaluate / click / type / set file inputs / keys / screenshots, and console errors collected.
// No dependencies: Node's own WebSocket and fetch.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

/** The system Chrome, or undefined (the smoke test then skips). */
export function findChrome() {
  return CANDIDATES.find((p) => p && existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts headless Chrome and returns a page driver. `close()` kills Chrome and removes its profile.
 * Every helper that waits takes a timeout and throws with what it was waiting for.
 */
export async function launch({ width = 1440, height = 900, chrome = findChrome() } = {}) {
  if (!chrome) throw new Error("Chrome not found");
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "katana-smoke-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let ws;
  for (let i = 0; i < 75 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      // Not listening yet.
    }
    if (!ws) await sleep(200);
  }
  if (!ws) {
    proc.kill("SIGKILL");
    throw new Error("Chrome did not open a debugging port");
  }
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const errors = [];
  const listeners = new Set();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.trim());
    for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("DOM.enable");

  const page = {
    send,
    /** Listens to every protocol event (`{ method, params }`); returns the unsubscribe function. */
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Console errors, uncaught exceptions and failed loads since the last `clearErrors()`. */
    errors,
    clearErrors: () => void errors.splice(0),

    async viewport(w, h, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    },
    async reducedMotion(on) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }] });
    },
    async goto(url, { wait = "load", timeout = 20_000 } = {}) {
      const loaded = new Promise((resolve) => {
        const l = (msg) => {
          if (msg.method === (wait === "load" ? "Page.loadEventFired" : "Page.domContentEventFired")) {
            listeners.delete(l);
            resolve();
          }
        };
        listeners.add(l);
      });
      await send("Page.navigate", { url });
      await Promise.race([loaded, sleep(timeout).then(() => Promise.reject(new Error(`timed out loading ${url}`)))]);
    },
    /** Evaluates an expression in the page (promises awaited) and returns its value. */
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  ${expression.slice(0, 200)}`);
      return r.result.value;
    },
    /** Polls until `expression` is truthy; returns its value. */
    async waitFor(expression, { timeout = 10_000, what = expression } = {}) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try {
          last = await page.eval(expression);
          if (last) return last;
        } catch (e) {
          last = e.message;
        }
        await sleep(150);
      }
      throw new Error(`timed out after ${timeout} ms waiting for ${what} (last: ${JSON.stringify(last)})`);
    },
    /** Clicks the centre of the first element matching `selector` (or a JS expression returning an element). */
    async click(target) {
      const expr = target.startsWith("js:") ? target.slice(3) : `document.querySelector(${JSON.stringify(target)})`;
      const box = await page.eval(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) throw new Error(`nothing to click: ${target}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    async key(key, { shift = false } = {}) {
      const codes = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32 };
      const modifiers = shift ? 8 : 0;
      const text = key === "Enter" ? "\r" : key.length === 1 ? key : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, text, modifiers, windowsVirtualKeyCode: codes[key] ?? 0 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers, windowsVirtualKeyCode: codes[key] ?? 0 });
    },
    /** Sets files on an `<input type=file>` (found by selector or JS expression) and fires change. */
    async setFiles(target, files) {
      const expr = target.startsWith("js:") ? target.slice(3) : `document.querySelector(${JSON.stringify(target)})`;
      const { result } = await send("Runtime.evaluate", { expression: expr });
      if (!result.objectId) throw new Error(`no file input: ${target}`);
      await send("DOM.setFileInputFiles", { objectId: result.objectId, files });
    },
    async screenshot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    async close() {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      proc.kill("SIGKILL");
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    },
  };
  await page.viewport(width, height);
  return page;
}
