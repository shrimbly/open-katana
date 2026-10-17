import { useState } from "preact/hooks";
import type { SetupStatus } from "../../../src/app/types.js";
import { app } from "./api.js";
import type { setupBanner } from "./copy.js";
import { Link } from "./router.js";
import { refreshSetup } from "./Shell.js";
import { toast } from "./ui.js";

/**
 * The one-line banner under the header while edits can't be made yet (spec §4.1). Browsing and
 * decoding keep working, so it says so. One message at a time, the most blocking first (the Shell
 * picks it with `setupBanner`).
 *
 * `floating`: the message arrived after the page was drawn, so it lies over the top of the page
 * instead of pushing it down. `done`: the row stays in place after setup was fixed, until the next page.
 */
export interface SetupBannerProps {
  setup?: SetupStatus;
  banner?: NonNullable<ReturnType<typeof setupBanner>>;
  floating?: boolean;
  done?: boolean;
}

export function SetupBanner({ setup, banner, floating, done }: SetupBannerProps) {
  const [saving, setSaving] = useState(false);

  if (done || !banner || !setup)
    return (
      <div class="kt-banner done" role="region" aria-label="Setup">
        <p>Ready to make edits.</p>
      </div>
    );

  const saveSecret = async () => {
    setSaving(true);
    try {
      await app.saveGpu({ kind: setup.gpu.kind ?? "cloud", saveEnvSecret: true });
      await refreshSetup(true);
      toast("Saved. The director can use your Comfy Cloud key now.");
    } catch (e) {
      toast((e as Error).message, { error: true });
    } finally {
      setSaving(false);
    }
  };

  const action =
    banner.action === "ffmpeg" ? (
      <Link class="btn small" href="/setup#ffmpeg">
        How
      </Link>
    ) : banner.action === "save-secret" ? (
      <button type="button" class="btn small" disabled={saving} onClick={saveSecret}>
        Save it
      </button>
    ) : (
      <Link class="btn small" href={banner.action === "models" ? "/setup#gpu" : "/setup"}>
        Set up
      </Link>
    );

  const row = (
    <div class={`kt-banner${floating ? " floating" : ""}`} role="region" aria-label="Setup">
      <p>{banner.text}</p>
      {action}
    </div>
  );
  return floating ? <div class="kt-banner-float">{row}</div> : row;
}
