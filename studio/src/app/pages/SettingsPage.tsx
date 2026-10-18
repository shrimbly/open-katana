import { useEffect, useState } from "preact/hooks";
import type { AppSettings, LinkStatus } from "../../../../src/app/types.js";
import { app } from "../api.js";
import { saveSettings, useApp } from "../Shell.js";
import { toast } from "../ui.js";

/**
 * Settings (spec §4.13): the director's model, how many edits run at once, the default Claude cap,
 * keep-awake and the licence notes. Each change saves at once.
 */
export function SettingsPage() {
  const { settings } = useApp();
  const [saved, setSaved] = useState("");
  const [cap, setCap] = useState<string>();
  const [links, setLinks] = useState<LinkStatus>();
  const [igUser, setIgUser] = useState<string>();
  useEffect(() => {
    document.title = "Settings · open-katana";
  }, []);
  const refreshLinks = () => app.links().then(setLinks, () => setLinks(undefined));
  useEffect(() => {
    void refreshLinks();
  }, []);

  const save = async (patch: Partial<AppSettings>, said = "Saved.") => {
    try {
      await saveSettings(patch);
      setSaved("");
      requestAnimationFrame(() => setSaved(said));
    } catch (e) {
      toast(`Not saved: ${(e as Error).message}`, { error: true });
    }
  };

  if (!settings)
    return (
      <main id="content" class="kt-page kt-settings" aria-busy="true">
        <h1 class="kt-display-l">Settings</h1>
      </main>
    );

  const capValue = cap ?? String(settings.defaultClaudeCapUsd);
  const commitCap = () => {
    const n = Math.round(Number(capValue) / 5) * 5;
    if (!Number.isFinite(n) || n < 5 || n > 200) {
      setCap(undefined);
      toast("The cap can be $5 to $200, in steps of $5.", { error: true });
      return;
    }
    setCap(undefined);
    if (n !== settings.defaultClaudeCapUsd) void save({ defaultClaudeCapUsd: n });
  };

  return (
    <main id="content" class="kt-page kt-settings">
      <h1 class="kt-display-l kt-slam">Settings</h1>

      <fieldset class="kt-setting">
        <legend class="label">Director model</legend>
        <label class="kt-radio">
          <input type="radio" name="model" checked={settings.model === "opus"} onChange={() => save({ model: "opus" })} />
          <span>
            <strong>Opus</strong> — best at judging likeness <span class="kt-ash">(default)</span>
          </span>
        </label>
        <label class="kt-radio">
          <input type="radio" name="model" checked={settings.model === "sonnet"} onChange={() => save({ model: "sonnet" })} />
          <span>
            <strong>Sonnet</strong> — cheaper, worse at likeness
          </span>
        </label>
      </fieldset>

      <div class="kt-setting">
        <label class="label" for="parallel">
          Edits at once
        </label>
        <div class="kt-setting-row">
          <select
            id="parallel"
            class="kt-input kt-select mono"
            value={String(settings.maxParallelRuns)}
            onChange={(e) => save({ maxParallelRuns: Number(e.currentTarget.value) as 1 | 2 | 3 })}
            aria-describedby="parallel-help"
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
          <p class="kt-help" id="parallel-help">
            Comfy Cloud credits are shared across your workspace.
          </p>
        </div>
      </div>

      <div class="kt-setting">
        <label class="label" for="claude-cap">
          Default Claude cap
        </label>
        <div class="kt-setting-row">
          <span class="kt-money">
            <span aria-hidden="true">$</span>
            <input
              id="claude-cap"
              class="kt-input mono"
              type="number"
              inputMode="numeric"
              min={5}
              max={200}
              step={5}
              value={capValue}
              onInput={(e) => setCap(e.currentTarget.value)}
              onBlur={commitCap}
              onKeyDown={(e) => e.key === "Enter" && commitCap()}
              aria-describedby="cap-help"
            />
          </span>
          <p class="kt-help" id="cap-help">
            What the director may use on one edit before it pauses and asks. You can change it per edit.
          </p>
        </div>
      </div>

      <div class="kt-setting">
        <label class="kt-check">
          <input type="checkbox" checked={settings.keepAwake} onChange={(e) => save({ keepAwake: e.currentTarget.checked })} />
          <span>Keep this Mac awake while making an edit (macOS only)</span>
        </label>
      </div>

      <InstagramSetting
        settings={settings}
        links={links}
        user={igUser}
        onUser={setIgUser}
        onSave={async (patch) => {
          await save(patch);
          setIgUser(undefined);
          void refreshLinks();
        }}
      />

      <div class="kt-setting">
        <span class="label">Licence notes</span>
        <div class="kt-setting-row">
          <button
            type="button"
            class="btn"
            disabled={settings.licencesAcknowledged.length === 0}
            onClick={() => save({ licencesAcknowledged: [] }, "The licence notes will show again before your next edit.")}
          >
            Show them again
          </button>
          <p class="kt-help">
            {settings.licencesAcknowledged.length
              ? `You've read the notes for ${settings.licencesAcknowledged.length} ${settings.licencesAcknowledged.length === 1 ? "model" : "models"}.`
              : "They show before your next edit."}
          </p>
        </div>
      </div>

      <p class="kt-saved-note" role="status" aria-live="polite">
        {saved}
      </p>
    </main>
  );
}

const BROWSERS = ["chrome", "firefox", "safari", "edge", "brave", "opera", "vivaldi", "chromium"] as const;
const titleCase = (b: string) => b.charAt(0).toUpperCase() + b.slice(1);

/** Instagram links: whether instaloader is here, and how it signs in. No password is ever asked for or kept. */
function InstagramSetting(p: { settings: AppSettings; links?: LinkStatus; user?: string; onUser(v: string | undefined): void; onSave(patch: Partial<AppSettings>): Promise<void> }) {
  const value = p.user ?? p.settings.instagramUser ?? "";
  const commit = () => {
    const v = value.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{0,30}$/.test(v)) {
      toast("An Instagram username has letters, numbers, dots and underscores.", { error: true });
      return;
    }
    if (v !== (p.settings.instagramUser ?? "")) void p.onSave({ instagramUser: v });
    else p.onUser(undefined);
  };
  const tool = p.links?.instaloader;
  const login = p.links?.login;
  return (
    <fieldset class="kt-setting">
      <legend class="label">Instagram links</legend>
      <p class="kt-help">
        {!p.links
          ? "Checking for instaloader…"
          : tool?.found
            ? `instaloader ${tool.version} is ready: paste a reel link on Home to copy its edit, or on a template to use its sound.`
            : `Install instaloader to paste Instagram links: ${tool?.install ?? "pipx install instaloader"}`}
      </p>
      <div class="kt-setting-row">
        <label class="kt-fine" for="ig-user">
          Your Instagram username (optional)
        </label>
        <input
          id="ig-user"
          class="kt-input mono"
          autoComplete="off"
          spellcheck={false}
          placeholder="username"
          value={value}
          onInput={(e) => p.onUser(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          aria-describedby="ig-user-help"
        />
        <p class="kt-help" id="ig-user-help">
          Instagram often wants you signed in. Run <code>instaloader --login {value || "username"}</code> once in a terminal: it saves a session, and your
          password stays with instaloader. {login?.mode === "session" ? "Saved session found." : value && login?.sessionFound === false ? "No saved session for this name yet." : ""}
        </p>
      </div>
      <div class="kt-setting-row">
        <label class="kt-fine" for="ig-browser">
          Or borrow the Instagram login of a browser
        </label>
        <select
          id="ig-browser"
          class="kt-input kt-select"
          value={p.settings.instagramBrowser ?? ""}
          onChange={(e) => void p.onSave({ instagramBrowser: e.currentTarget.value })}
        >
          <option value="">No browser</option>
          {BROWSERS.map((b) => (
            <option value={b} key={b}>
              {titleCase(b)}
            </option>
          ))}
        </select>
      </div>
      <p class="kt-help">Links are fetched on this computer. Copy only edits, and use only sounds, you have the rights to.</p>
    </fieldset>
  );
}
