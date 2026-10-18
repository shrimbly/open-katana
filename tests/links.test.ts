import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importInstagram, instagramShortcode, linkStatus, sessionFile } from "../src/app/links.js";
import { DEFAULT_APP_SETTINGS } from "../src/app/schemas.js";
import type { AppSettings } from "../src/app/types.js";
import { tempDir } from "./helpers/synth.js";

/**
 * A stand-in for instaloader: `--version`, then a download of `-<shortcode>` into --dirname-pattern as
 * "{profile}__{shortcode}.mp4", or a failure picked by FAKE_IG. It records its arguments for the tests.
 */
const FAKE = `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("4.15.4"); process.exit(0); }
appendFileSync(process.env.FAKE_IG_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_IG ?? "ok";
const dir = args[args.indexOf("--dirname-pattern") + 1];
const code = args[args.length - 1].slice(1);
if (mode === "login") { console.error("Login required."); process.exit(1); }
if (mode === "ratelimit") { console.error('JSON Query to graphql/query: 401 Unauthorized - "fail" status, message "Please wait a few minutes before you try again."'); process.exit(1); }
if (mode === "notfound") { console.error("Fetching Post metadata failed."); process.exit(1); }
if (mode === "picture") process.exit(0);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=220:duration=12",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", dir + "/someone__" + code + ".mp4"]);
`;

let log = "";
let config = "";
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_APP_SETTINGS, ...over });
const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
const before = { ...process.env };

beforeAll(async () => {
  const dir = await tempDir();
  const bin = join(dir, "instaloader-fake.mjs");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  log = join(dir, "calls.jsonl");
  await writeFile(log, "");
  config = join(dir, "config");
  Object.assign(process.env, { OPEN_KATANA_INSTALOADER: bin, FAKE_IG_LOG: log, XDG_CONFIG_HOME: config });
});
afterAll(() => {
  for (const k of ["OPEN_KATANA_INSTALOADER", "FAKE_IG_LOG", "FAKE_IG", "XDG_CONFIG_HOME"]) {
    if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
});

describe("Instagram links", () => {
  it("read the shortcode of reel and post links, and nothing else", () => {
    expect(instagramShortcode("https://www.instagram.com/reel/DAbc_12-xY/")).toBe("DAbc_12-xY");
    expect(instagramShortcode("https://instagram.com/p/C9z8y7x6w5/?igsh=abc")).toBe("C9z8y7x6w5");
    expect(instagramShortcode("https://www.instagram.com/someone/reel/DAbc_12-xY")).toBe("DAbc_12-xY");
    expect(instagramShortcode("https://www.instagram.com/reels/DAbc_12-xY/")).toBe("DAbc_12-xY");
    expect(instagramShortcode("https://www.instagram.com/someone/")).toBeUndefined();
    expect(instagramShortcode("https://evil.example/instagram.com/reel/DAbc_12-xY/")).toBeUndefined();
    expect(instagramShortcode("https://www.instagram.com/reel/DAbc_12-xY/; rm -rf /")).toBeUndefined();
  });

  it("stage a reel as an edit to decode, or its sound as a track", async () => {
    process.env.FAKE_IG = "ok";
    const edit = await importInstagram("https://www.instagram.com/reel/DAbc12xY9/", "edit", settings());
    expect(edit).toMatchObject({ purpose: "edit", kind: "video", hasAudio: true, name: "@someone · DAbc12xY9.mp4" });
    expect(edit.durationSec).toBeCloseTo(12, 0);
    const music = await importInstagram("https://www.instagram.com/reel/DAbc12xY9/", "music", settings());
    expect(music).toMatchObject({ purpose: "music", kind: "audio", name: "@someone · DAbc12xY9 sound.m4a" });
    // Only the post was asked for, quietly, without pictures or metadata, and signed out.
    const args = (await calls()).at(-1)!;
    expect(args.slice(-2)).toEqual(["--", "-DAbc12xY9"]);
    expect(args).toEqual(expect.arrayContaining(["--quiet", "--no-pictures", "--no-metadata-json", "--no-captions"]));
    expect(args).not.toContain("--login");
  });

  it("use a saved session or a browser's login, and never ask for a password", async () => {
    process.env.FAKE_IG = "ok";
    // A username without a saved session: --login would prompt for a password, so it isn't passed.
    await importInstagram("https://www.instagram.com/reel/DAbc12xY9/", "edit", settings({ instagramUser: "me.here" }));
    expect((await calls()).at(-1)).not.toContain("--login");
    expect((await linkStatus(settings({ instagramUser: "me.here" }))).login).toEqual({ mode: "none", username: "me.here", sessionFound: false });
    await mkdir(join(config, "instaloader"), { recursive: true });
    await writeFile(sessionFile("me.here"), "session");
    await importInstagram("https://www.instagram.com/reel/DAbc12xY9/", "edit", settings({ instagramUser: "me.here" }));
    expect((await calls()).at(-1)).toEqual(expect.arrayContaining(["--login", "me.here"]));
    await importInstagram("https://www.instagram.com/reel/DAbc12xY9/", "edit", settings({ instagramBrowser: "firefox" }));
    expect((await calls()).at(-1)).toEqual(expect.arrayContaining(["--load-cookies", "firefox"]));
    expect((await linkStatus(settings())).instaloader).toMatchObject({ found: true, version: "4.15.4" });
  });

  it("explain each failure in words a person can act on", async () => {
    const cases: [string, number, string, RegExp][] = [
      ["login", 403, "IG_LOGIN", /instaloader --login/],
      ["ratelimit", 429, "IG_RATE_LIMIT", /Wait a few minutes/],
      ["notfound", 404, "IG_NOT_FOUND", /If the link opens in your browser, Instagram wants you signed in/],
      ["picture", 422, "IG_NO_VIDEO", /no video/],
    ];
    for (const [mode, status, code, message] of cases) {
      process.env.FAKE_IG = mode;
      const e = await importInstagram("https://www.instagram.com/p/DAbc12xY9/", "edit", settings()).catch((x) => x);
      expect(e, mode).toMatchObject({ status, code });
      expect(e.message, mode).toMatch(message);
    }
    const bad = await importInstagram("https://www.tiktok.com/@x/video/123", "edit", settings()).catch((x) => x);
    expect(bad).toMatchObject({ status: 422, code: "IG_BAD_LINK" });
  });
});
