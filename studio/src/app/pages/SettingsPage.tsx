import { useEffect, useState } from "preact/hooks";
import type { AppSettings } from "../../../../src/app/types.js";
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
  useEffect(() => {
    document.title = "Settings · open-katana";
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
