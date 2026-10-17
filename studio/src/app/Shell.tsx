import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppSettings, Info, RunStatus, RunSummary, SetupStatus } from "../../../src/app/types.js";
import { app, MOCK } from "./api.js";
import { modelsBlockEveryTemplate, setupBanner, setupPill } from "./copy.js";
import { Link, useRoute } from "./router.js";
import { SetupBanner } from "./SetupBanner.js";
import { Icon, Toaster } from "./ui.js";

export { gpuName, setupPill } from "./copy.js";

/**
 * The app chrome around every page but the editor (spec §4.1): skip link, 52 px header with the
 * wordmark, Templates and Your edits (with a count of edits that are making or need you), the setup
 * pill and Settings; then the setup banner, the page and the toasts.
 *
 * It also holds what every page shares: setup status, runs, info and settings, kept fresh by the
 * global event channel.
 */

interface AppState {
  /** Fresh from the server (undefined until the first answer); pages gate actions on this. */
  setup?: SetupStatus;
  /** Every template's title, to tell when missing models leave none that can be made. */
  templateTitles?: string[];
  runs: RunSummary[];
  info?: Info;
  settings?: AppSettings;
  /** Bumped when the server says templates or projects changed. */
  templatesRev: number;
  projectsRev: number;
}

const state: AppState = { runs: [], templatesRev: 0, projectsRev: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<AppState>) => {
  Object.assign(state, patch);
  for (const l of listeners) l();
};

let setupInFlight: Promise<SetupStatus | undefined> | undefined;

/**
 * The last setup status this browser saw, so the header pill and the setup banner are drawn with the
 * page instead of popping in (and pushing the page down) when the slow first check answers. Only the
 * chrome uses it; pages wait for the fresh status before they allow anything.
 */
interface SetupMemo {
  v: 1;
  setup: SetupStatus;
  templateTitles?: string[];
}
const MEMO_KEY = MOCK ? "katana-setup-mock" : "katana-setup";
function readMemo(): SetupMemo | undefined {
  try {
    const m = JSON.parse(localStorage.getItem(MEMO_KEY) ?? "null") as SetupMemo | null;
    return m?.v === 1 && m.setup?.gpu && m.setup.ready ? m : undefined;
  } catch {
    return undefined;
  }
}
function writeMemo(): void {
  if (!state.setup) return;
  try {
    localStorage.setItem(MEMO_KEY, JSON.stringify({ v: 1, setup: state.setup, templateTitles: state.templateTitles } satisfies SetupMemo));
  } catch {
    // Private window or blocked storage: the chrome waits for the server instead.
  }
}
const memo = readMemo();

/** Re-reads setup status (`fresh` bypasses the server's 60 s cache, as **Check again** does). */
export function refreshSetup(fresh = false): Promise<SetupStatus | undefined> {
  if (setupInFlight && !fresh) return setupInFlight;
  const p = app.setup(fresh).then(
    (setup) => {
      set({ setup });
      writeMemo();
      return setup;
    },
    () => undefined,
  );
  setupInFlight = p.finally(() => (setupInFlight = undefined));
  return p;
}

const refreshTemplateTitles = () =>
  app.templates().then(
    ({ templates }) => {
      set({ templateTitles: templates.map((t) => t.title) });
      writeMemo();
    },
    () => undefined,
  );

export const refreshRuns = () =>
  app.runs().then(
    ({ runs }) => set({ runs }),
    () => undefined,
  );

export const refreshSettings = () =>
  app.settings().then(
    (settings) => {
      set({ settings });
      return settings;
    },
    () => undefined,
  );

/** Saves a settings change and shares the result with every page. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const settings = await app.saveSettings(patch);
  set({ settings });
  return settings;
}

let started = false;
function start() {
  if (started) return;
  started = true;
  void refreshSetup();
  void refreshTemplateTitles();
  void refreshRuns();
  void refreshSettings();
  app.info().then(
    (info) => set({ info }),
    () => undefined,
  );
  app.events(
    (e) => {
      if (e.type === "runs") set({ runs: e.runs });
      else if (e.type === "setup") void refreshSetup();
      else if (e.type === "templates") {
        set({ templatesRev: state.templatesRev + 1 });
        void refreshTemplateTitles();
      }
      else if (e.type === "projects") set({ projectsRev: state.projectsRev + 1 });
    },
    // A reconnect may have missed events: read the runs again.
    { onOpen: () => void refreshRuns() },
  );
}

/** The shared app state; re-renders on every change. */
export function useApp(): AppState {
  const [, bump] = useState(0);
  useEffect(() => {
    start();
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

/** Statuses that hold the person's attention: being made, waiting in line, or waiting for them. */
export const ACTIVE: RunStatus[] = ["queued", "starting", "running", "stopping", "paused"];

export function Shell({ children }: { children: ComponentChildren }) {
  const { setup: fresh, templateTitles, runs } = useApp();
  const { path } = useRoute();
  const home = path === "/";
  const count = runs.filter((r) => ACTIVE.includes(r.status)).length;
  // Until the first check answers, the chrome shows what this browser saw last time.
  const setup = fresh ?? memo?.setup;
  const blocked = setup ? modelsBlockEveryTemplate(setup, templateTitles ?? memo?.templateTitles) : false;
  const pill = setupPill(setup, blocked);
  const banner = setup && path !== "/setup" ? setupBanner(setup, blocked) : undefined;
  const slot = useBannerSlot(path, Boolean(banner));
  const onEdits = path === "/edits" || path.startsWith("/p/") || path.startsWith("/decode/");
  return (
    <div class="kt">
      <a class="kt-skip" href={home ? "#templates" : "#content"}>
        {home ? "Skip to templates" : "Skip to content"}
      </a>
      <header class="kt-header">
        <Link class="kt-wordmark" href="/" aria-label="open-katana, home">
          OPEN-KATANA
        </Link>
        <nav class="kt-nav" aria-label="Main">
          <Link href="/" aria-current={home || path.startsWith("/t/") ? "page" : undefined}>
            Templates
          </Link>
          <Link href="/edits" aria-current={onEdits ? "page" : undefined}>
            Your edits
            {count > 0 && (
              <>
                <span class="kt-count mono" aria-hidden="true">
                  {count}
                </span>
                <span class="kt-sr">{`, ${count} active`}</span>
              </>
            )}
          </Link>
        </nav>
        <span class="spacer" />
        {MOCK && <span class="kt-mock label">Mock data</span>}
        {/* Its place is kept while the first check runs, so nothing jumps when it answers. */}
        <Link class={`kt-pill ${pill?.tone ?? "pending"}`} href="/setup" aria-current={path === "/setup" ? "page" : undefined} aria-busy={pill ? undefined : "true"}>
          <span class="kt-dot" aria-hidden="true" />
          {pill?.text ?? "Checking…"}
        </Link>
        <Link class="btn ghost icon-btn kt-gear" href="/settings" aria-label="Settings" aria-current={path === "/settings" ? "page" : undefined}>
          <Icon name="gear" />
        </Link>
      </header>
      {banner && setup && (slot === "flow" ? <SetupBanner setup={setup} banner={banner} /> : <SetupBanner setup={setup} banner={banner} floating />)}
      {!banner && slot === "flow" && path !== "/setup" && <SetupBanner done />}
      {children}
      <Toaster />
    </div>
  );
}

/**
 * Where the setup banner goes without moving the page (spec §16, no layout shift). A banner known when
 * a page is first drawn sits in the flow under the header. One that arrives later (the first setup
 * check can take seconds) floats over the top of the page instead, and joins the flow at the next
 * navigation. A banner in the flow that is no longer needed keeps its row, saying edits can be made,
 * until then.
 */
function useBannerSlot(path: string, shown: boolean): "flow" | "float" | undefined {
  const slot = useRef<{ path: string; flow: boolean }>();
  if (!slot.current || slot.current.path !== path) slot.current = { path, flow: shown };
  if (slot.current.flow) return "flow";
  return shown ? "float" : undefined;
}
