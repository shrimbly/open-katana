import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../util/proc.js";
import { HttpError } from "./router.js";
import type { AppSettings, LinkStatus, Upload } from "./types.js";
import { storeLocalUpload } from "./uploads.js";

/**
 * Instagram links: a reel or post is fetched with instaloader (github.com/instaloader/instaloader, MIT),
 * which the person installs themselves, and becomes an ordinary staged upload: the video, to decode and
 * copy the edit, or its sound, to cut a template to. The app never asks for or keeps an Instagram
 * password: it uses a session saved by `instaloader --login` or, when the person opts in, the
 * Instagram cookies of a browser they name.
 */

const LINK = /^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:[A-Za-z0-9._]{1,30}\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#].*)?$/;

/** The post's shortcode from a reel or post link, or undefined when the link isn't one. */
export function instagramShortcode(url: string): string | undefined {
  return LINK.exec(url.trim())?.[1];
}

export const INSTALOADER_BROWSERS = ["chrome", "firefox", "safari", "edge", "brave", "opera", "vivaldi", "chromium"] as const;
export type InstaloaderBrowser = (typeof INSTALOADER_BROWSERS)[number];

const INSTALL = "pipx install instaloader";
const TIMEOUT_MS = 90_000;

/** How to start instaloader: OPEN_KATANA_INSTALOADER (a path), then `instaloader` on PATH, then `python3 -m instaloader`. */
async function command(): Promise<{ cmd: string; pre: string[]; version: string } | undefined> {
  const candidates: [string, string[]][] = [
    ...(process.env.OPEN_KATANA_INSTALOADER ? ([[process.env.OPEN_KATANA_INSTALOADER, []]] as [string, string[]][]) : []),
    ["instaloader", []],
    ["python3", ["-m", "instaloader"]],
  ];
  for (const [cmd, pre] of candidates) {
    try {
      const r = await run(cmd, [...pre, "--version"]);
      const version = `${r.stdout}${r.stderr}`.trim().split(/\s+/).pop();
      if (version && /^\d/.test(version)) return { cmd, pre, version };
    } catch {
      // try the next way of starting it
    }
  }
  return undefined;
}

/** Where `instaloader --login <name>` saves its session (instaloader's own default path). */
export function sessionFile(username: string): string {
  const base =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Instaloader")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "instaloader");
  return join(base, `session-${username}`);
}

function loginArgs(settings: Pick<AppSettings, "instagramUser" | "instagramBrowser">): { args: string[]; status: LinkStatus["login"] } {
  const user = settings.instagramUser;
  if (user) {
    const found = existsSync(sessionFile(user));
    // Without a saved session, --login would ask for a password: never pass it then.
    if (found) return { args: ["--login", user], status: { mode: "session", username: user, sessionFound: true } };
    if (!settings.instagramBrowser) return { args: [], status: { mode: "none", username: user, sessionFound: false } };
  }
  if (settings.instagramBrowser) return { args: ["--load-cookies", settings.instagramBrowser], status: { mode: "browser", browser: settings.instagramBrowser } };
  return { args: [], status: { mode: "none" } };
}

export async function linkStatus(settings: AppSettings): Promise<LinkStatus> {
  const c = await command();
  return { instaloader: { found: Boolean(c), ...(c ? { version: c.version } : {}), install: INSTALL }, login: loginArgs(settings).status };
}

function runInstaloader(cmd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    // stdin closed: instaloader can never stop to ask for a password.
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (b: Buffer) => {
      output = (output + b.toString()).slice(-8000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += "\n[timed out]";
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** instaloader's failure, in words a person can act on. */
function failure(output: string, login: LinkStatus["login"]): HttpError {
  const o = output.toLowerCase();
  const signIn =
    login.mode === "none"
      ? login.username
        ? `Run \`instaloader --login ${login.username}\` once in a terminal to save a session (your password stays with instaloader), or pick a browser to borrow its Instagram login in Settings.`
        : "Add your Instagram username in Settings and run `instaloader --login <username>` once in a terminal, or pick a browser to borrow its Instagram login."
      : "Your saved Instagram login may have expired: run `instaloader --login` again, or check you're signed in to Instagram in that browser.";
  if (o.includes("[timed out]")) return new HttpError(504, "Instagram took too long to answer. Try again in a minute.", "IG_TIMEOUT");
  if (/please wait a few minutes|429|too many requests|rate.?limit/.test(o)) return new HttpError(429, `Instagram is limiting requests right now. Wait a few minutes and try again. ${login.mode === "none" ? signIn : ""}`.trim(), "IG_RATE_LIMIT");
  if (/login required|401|redirected to login|checkpoint|not logged in|private profile|is private/.test(o)) return new HttpError(403, `Instagram wants you signed in for this post. ${signIn}`, "IG_LOGIN");
  // instaloader says "Fetching Post metadata failed" both for a missing post and when Instagram wants a login.
  if (/404|not found|does not exist|fetching post metadata failed|no such post/.test(o))
    return new HttpError(
      404,
      login.mode === "none"
        ? `Instagram didn't return that post. If the link opens in your browser, Instagram wants you signed in: ${signIn}`
        : "That post isn't there anymore, it's private, or the link is wrong.",
      "IG_NOT_FOUND",
    );
  if (/browser_cookie3|cookie/.test(o) && login.mode === "browser") return new HttpError(502, `Couldn't read Instagram cookies from ${login.browser}. Sign in to Instagram there, close the browser, and try again.`, "IG_COOKIES");
  return new HttpError(502, `Couldn't fetch that post: ${output.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "instaloader failed"}`, "IG_FAILED");
}

/**
 * Fetches a reel or post and stages it as an upload: the video ("edit") or its audio track ("music").
 * The download lives in a temporary folder that is removed afterwards, whatever happens.
 */
export async function importInstagram(url: string, purpose: "edit" | "music", settings: AppSettings): Promise<Upload> {
  const shortcode = instagramShortcode(url);
  if (!shortcode) throw new HttpError(422, "Paste an Instagram reel or post link, like https://www.instagram.com/reel/ABC123/.", "IG_BAD_LINK");
  const c = await command();
  if (!c) throw new HttpError(412, `Instagram links need instaloader. Install it with \`${INSTALL}\`, then try again.`, "IG_NOT_INSTALLED");
  const { args: login, status } = loginArgs(settings);
  const dir = await mkdtemp(join(tmpdir(), "ok-ig-"));
  try {
    const { code, output } = await runInstaloader(c.cmd, [
      ...c.pre,
      "--quiet", "--no-pictures", "--no-video-thumbnails", "--no-metadata-json", "--no-captions", "--no-compress-json", "--no-profile-pic",
      "--max-connection-attempts", "1", "--request-timeout", "30",
      "--dirname-pattern", dir, "--filename-pattern", "{profile}__{shortcode}",
      ...login,
      "--", `-${shortcode}`,
    ]);
    const videos = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
    if (!videos.length) {
      if (code === 0) throw new HttpError(422, "That post has no video. Paste a reel, or a post with a video in it.", "IG_NO_VIDEO");
      throw failure(output, status);
    }
    const video = join(dir, videos[0]!);
    const profile = videos[0]!.split("__")[0];
    const label = `${profile ? `@${profile} · ` : ""}${shortcode}`;
    if (purpose === "edit") return await storeLocalUpload(video, "edit", `${label}.mp4`);
    const audio = join(dir, "sound.m4a");
    try {
      await run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vn", "-c:a", "aac", "-b:a", "192k", audio]);
    } catch {
      throw new HttpError(422, "That post has no sound to use.", "IG_NO_AUDIO");
    }
    return await storeLocalUpload(audio, "music", `${label} sound.m4a`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
