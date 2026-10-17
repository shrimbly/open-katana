import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { GpuSetupRequest, SetupStatus } from "../../../../src/app/types.js";
import { app } from "../api.js";
import { gpuName, missingProfiles, modelsBlockEveryTemplate } from "../copy.js";
import { shortModel } from "../Receipt.js";
import { refreshSetup, useApp } from "../Shell.js";
import { Button, Icon, toast } from "../ui.js";

/**
 * Setup (spec §4.12): the three things that make edits (the director, your GPU, ffmpeg), each with its
 * state and the one fix it needs. Keys are write-only: a saved key shows as saved, never echoed.
 */

const ROLE: Record<string, string> = {
  "still.compose": "keyframes",
  "still.face": "face crop",
  "still.generate": "plates",
  "clip.i2v": "clips",
  "clip.flf": "transitions",
  "clip.r2v": "reference clips",
  "clip.motion": "motion clips",
  matte: "cut-outs",
};

/** "MiniMax H3 (clips)"; "Face crop" alone when the name already says what it does. */
function modelWithRole(p: { title: string; operation: string }): string {
  const name = shortModel(p.title);
  const role = ROLE[p.operation] ?? p.operation;
  return name.toLowerCase() === role.toLowerCase() ? name : `${name} (${role})`;
}

const INSTALL_GUIDE = "https://docs.claude.com/en/docs/claude-code/setup";

type Where = "cloud" | "local" | "remote";

function osInstall(): string {
  const p = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac/i.test(p)) return "brew install ffmpeg";
  if (/Win/i.test(p)) return "winget install ffmpeg";
  return "sudo apt install ffmpeg";
}

const isLoopback = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
};

export function SetupPage() {
  const { setup, templateTitles } = useApp();
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    document.title = "Set up · open-katana";
    void refreshSetup();
  }, []);

  const check = async () => {
    setChecking(true);
    const s = await refreshSetup(true);
    setChecking(false);
    if (!s) toast("Setup couldn't be checked. Is open-katana still running?", { error: true });
    else toast(s.ready.make && !modelsBlockEveryTemplate(s, templateTitles) ? "Everything is ready." : "Checked. Some things still need you.");
  };

  return (
    <main id="content" class="kt-page kt-setup">
      <h1 class="kt-display-l kt-slam">Set up</h1>
      <p class="kt-lede">Three things make edits. Decoding needs only ffmpeg.</p>
      {!setup ? (
        <p class="kt-ash" aria-busy="true">
          Checking…
        </p>
      ) : (
        <>
          <DirectorRow s={setup} />
          <GpuRow s={setup} templates={templateTitles} />
          <FfmpegRow s={setup} />
        </>
      )}
      <div class="kt-setup-foot">
        <Button variant="primary" disabled={checking} onClick={check}>
          {checking ? "Checking…" : "Check again"}
        </Button>
        {setup && (
          <span class="kt-fine">
            Checked at <span class="mono">{new Date(setup.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </span>
        )}
      </div>
    </main>
  );
}

function Row({ id, title, sub, ok, status, children }: { id?: string; title: string; sub?: string; ok: boolean | "warn"; status: string; children?: ComponentChildren }) {
  return (
    <section class={`kt-setup-row ${ok === true ? "ok" : ok === "warn" ? "warn" : "todo"}`} id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <div class="kt-setup-head">
        <span class="kt-dot" aria-hidden="true" />
        <h2 id={id ? `${id}-h` : undefined}>
          <span class="kt-setup-title">{title}</span>
          {sub && <span class="kt-setup-sub"> · {sub}</span>}
        </h2>
        <span class="kt-setup-status">
          {ok === true ? <Icon name="check" size={14} /> : <span aria-hidden="true">!</span>}
          {status}
        </span>
      </div>
      <div class="kt-setup-body">{children}</div>
    </section>
  );
}

function DirectorRow({ s }: { s: SetupStatus }) {
  const c = s.claude;
  if (c.state === "ok") {
    const auth = c.auth === "subscription" ? `Signed in · ${c.plan ?? "Claude plan"}` : c.auth === "api-key" ? "Signed in with an API key" : "Signed in";
    return (
      <Row id="director" title="The director" sub="Claude Code" ok status="Ready">
        <p class="kt-ash">
          <span class="mono">{c.version}</span> · {auth}
        </p>
      </Row>
    );
  }
  if (c.state === "missing")
    return (
      <Row id="director" title="The director" sub="Claude Code" ok={false} status="Not installed">
        <p>
          open-katana uses Claude Code as the director: it plans the shots, judges every take and cuts the edit. Install it, run <code>claude</code> once to sign in, then check
          again.
        </p>
        <a class="kt-link-ext" href={INSTALL_GUIDE} target="_blank" rel="noreferrer">
          Install guide
          <Icon name="external" size={12} />
        </a>
      </Row>
    );
  if (c.state === "too-old")
    return (
      <Row id="director" title="The director" sub="Claude Code" ok={false} status="Update needed">
        <p>This version{c.version ? <span class="mono"> ({c.version})</span> : null} can't run edits headlessly. Update it, then check again.</p>
        {c.missingFlags?.length ? <p class="kt-fine mono">Missing: {c.missingFlags.join(" ")}</p> : null}
      </Row>
    );
  if (c.state === "logged-out")
    return (
      <Row id="director" title="The director" sub="Claude Code" ok={false} status="Signed out">
        <p>
          Run <code>claude</code> in a terminal and sign in, then check again.
        </p>
      </Row>
    );
  return (
    <Row id="director" title="The director" sub="Claude Code" ok={false} status="Not working">
      <p>{c.message ?? "Claude Code didn't answer."}</p>
    </Row>
  );
}

function initialWhere(s: SetupStatus): Where {
  if (s.gpu.kind === "cloud" || s.gpu.kind === "comfy-cli" || s.gpu.where === "cloud") return "cloud";
  if (s.gpu.where === "remote") return "remote";
  return s.gpu.state === "not-configured" ? "cloud" : "local";
}

function GpuRow({ s, templates }: { s: SetupStatus; templates?: string[] }) {
  const g = s.gpu;
  const [where, setWhere] = useState<Where>(() => initialWhere(s));
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [url, setUrl] = useState(() => (g.where === "remote" && g.target ? g.target : "http://127.0.0.1:8188"));
  const [remoteUrl, setRemoteUrl] = useState(() => (g.where === "remote" && g.target ? g.target : "https://"));
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const connect = async (req: GpuSetupRequest, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await app.saveGpu(req);
      const fresh = await refreshSetup(true);
      setKey("");
      setToken("");
      setReplacing(false);
      if (fresh?.gpu.state === "ok") toast(done);
      else setError(fresh?.gpu.detail ?? "Saved, but the GPU didn't answer yet. Check that it's running, then check again.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Models no template uses (say, motion clips) aren't worth a download here; the receipt says if an edit needs them.
  const missing = missingProfiles(s);
  // Connected, but no template can be made until the models are there: the row needs the person too.
  const blockedAll = modelsBlockEveryTemplate(s, templates);
  const status =
    g.state === "ok" ? (blockedAll ? (g.onDemandModels ? "Missing nodes" : "Missing models") : "Ready") : g.state === "unreachable" ? "Offline" : g.state === "env-secret" ? "Key not saved" : "Not connected";
  const keyShown = !(g.keySaved && where === "cloud" && (g.kind === "cloud" || g.where === "cloud")) || replacing;
  const insecure = where === "remote" && remoteUrl.startsWith("http://") && !isLoopback(remoteUrl) && token.length > 0;

  return (
    <Row id="gpu" title="Your GPU" sub="ComfyUI" ok={g.state === "ok" && !blockedAll} status={status}>
      {g.state === "ok" && (
        <p class="kt-ash">
          {gpuName(s)}
          {g.target && g.where !== "cloud" ? <span class="mono"> · {g.target}</span> : null}
          {g.onDemandModels ? " · models load on demand" : ""}
        </p>
      )}
      {g.state === "unreachable" && <p>Can't reach your GPU{g.target ? <span class="mono"> at {g.target}</span> : null}. Start ComfyUI, then check again.</p>}
      {g.state === "env-secret" && (
        <p>
          Your Comfy Cloud key is set in this terminal only. Save it so the director can use it.{" "}
          <Button
            variant="primary"
            size="small"
            disabled={busy}
            onClick={() => connect({ kind: g.kind ?? "cloud", saveEnvSecret: true }, "Saved. The director can use your Comfy Cloud key now.")}
          >
            Save it
          </Button>
        </p>
      )}

      <div class="kt-segments" role="radiogroup" aria-label="Where your GPU is">
        {(
          [
            ["cloud", "Comfy Cloud"],
            ["local", "This computer"],
            ["remote", "Another computer"],
          ] as [Where, string][]
        ).map(([w, label]) => (
          <label key={w} class={`kt-segment${where === w ? " on" : ""}`}>
            <input type="radio" name="gpu-where" class="kt-sr" checked={where === w} onChange={() => setWhere(w)} />
            {label}
          </label>
        ))}
      </div>

      {where === "cloud" && (
        <form
          class="kt-gpu-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void connect({ kind: "cloud", apiKey: key.trim() }, "Connected to Comfy Cloud.");
          }}
        >
          {keyShown ? (
            <div class="kt-inline">
              <label class="kt-field-label" for="cloud-key">
                Comfy Cloud API key
              </label>
              <input
                id="cloud-key"
                class="kt-input mono"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={key}
                onInput={(e) => setKey(e.currentTarget.value)}
                placeholder="Paste your key"
              />
              <span class="kt-or">or</span>
              <Button variant="ghost" class="kt-outline" disabled={busy} onClick={() => connect({ kind: "comfy-cli" }, "Connected with your comfy CLI sign-in.")}>
                Use my comfy CLI sign-in
              </Button>
            </div>
          ) : (
            <p class="kt-inline">
              <span class="mono kt-saved">•••• saved</span>
              <Button variant="ghost" size="small" onClick={() => setReplacing(true)}>
                Replace
              </Button>
            </p>
          )}
          <div class="kt-gpu-foot">
            <p class="kt-fine">Credits are shared across your Comfy workspace.</p>
            {keyShown && (
              <Button variant="primary" type="submit" disabled={busy || !key.trim()}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            )}
          </div>
        </form>
      )}

      {where === "local" && (
        <form
          class="kt-gpu-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect({ kind: "http", url: url.trim() }, "Connected to the ComfyUI on this computer.");
          }}
        >
          <div class="kt-inline">
            <label class="kt-field-label" for="local-url">
              ComfyUI address
            </label>
            <input id="local-url" class="kt-input mono" value={url} spellcheck={false} onInput={(e) => setUrl(e.currentTarget.value)} />
          </div>
          <div class="kt-gpu-foot">
            <p class="kt-fine">Runs on this computer's GPU. Stop also cancels the GPU jobs of the edit you stop.</p>
            <Button variant="primary" type="submit" disabled={busy || !url.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </form>
      )}

      {where === "remote" && (
        <form
          class="kt-gpu-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect({ kind: "http", url: remoteUrl.trim(), ...(token.trim() ? { apiKey: token.trim() } : {}) }, "Connected to your other computer.");
          }}
        >
          <div class="kt-inline">
            <label class="kt-field-label" for="remote-url">
              ComfyUI address
            </label>
            <input id="remote-url" class="kt-input mono" value={remoteUrl} spellcheck={false} onInput={(e) => setRemoteUrl(e.currentTarget.value)} />
          </div>
          <div class="kt-inline">
            <label class="kt-field-label" for="remote-token">
              Token <span class="kt-optional">(optional)</span>
            </label>
            <input id="remote-token" class="kt-input mono" type="password" autocomplete="off" value={token} onInput={(e) => setToken(e.currentTarget.value)} />
          </div>
          {insecure && <p class="kt-warn-text">This sends your token without encryption. Use https:// for machines outside your network.</p>}
          <div class="kt-gpu-foot">
            <span />
            <Button variant="primary" type="submit" disabled={busy || remoteUrl.trim().length < 10}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p class="kt-error" role="alert">
          {error}
        </p>
      )}

      {missing.length > 0 && (
        <div class="kt-missing">
          <p>
            <strong>{blockedAll ? "Missing for every template." : "Missing for some templates."}</strong>
            {blockedAll && " Edits can be made once they're installed. Browsing and decoding work now."}
          </p>
          <ul class="kt-missing-list">
            {missing.map((p) => (
              <li key={p.id}>
                <p class="kt-missing-name">
                  {modelWithRole(p)}
                  {p.neededBy?.length ? <span class="kt-ash"> · needed by {p.neededBy.join(", ")}</span> : null}
                </p>
                <p class="kt-missing-files mono">{p.missing.join(", ")}</p>
                {p.links.length > 0 && (
                  <p class="kt-missing-links">
                    {p.links.map((l, i) => (
                      <a key={l} class="kt-link-ext" href={l} target="_blank" rel="noreferrer">
                        {p.links.length > 1 ? `Download ${i + 1}` : "Download link"}
                        <Icon name="external" size={11} />
                      </a>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Row>
  );
}

function FfmpegRow({ s }: { s: SetupStatus }) {
  if (s.ffmpeg.state === "ok")
    return (
      <Row id="ffmpeg" title="ffmpeg" ok status="Ready">
        <p class="kt-ash">
          <span class="mono">ffmpeg {s.ffmpeg.version}</span>
        </p>
      </Row>
    );
  return (
    <Row id="ffmpeg" title="ffmpeg" ok={false} status="Not found">
      <p>Install ffmpeg to decode and render edits, then check again:</p>
      <pre class="kt-code">{osInstall()}</pre>
    </Row>
  );
}
