import { type ComponentType, render, type VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./tokens.css";
import "./styles.css";
import "./app/app.css";
import { DecodePage } from "./app/pages/DecodePage.js";
import { Home } from "./app/pages/Home.js";
import { ProjectPage } from "./app/pages/ProjectPage.js";
import { ProjectsPage } from "./app/pages/ProjectsPage.js";
import { SettingsPage } from "./app/pages/SettingsPage.js";
import { SetupPage } from "./app/pages/SetupPage.js";
import { TemplatePage } from "./app/pages/TemplatePage.js";
import { matchPath, useRoute } from "./app/router.js";
import { Shell } from "./app/Shell.js";

// Links from agents and older builds open the editor as /?project=<id>.
const legacy = new URLSearchParams(location.search);
const legacyProject = legacy.get("project");
if (legacyProject) {
  legacy.delete("project");
  const rest = legacy.toString();
  history.replaceState(null, "", `/edit/${encodeURIComponent(legacyProject)}${rest ? `?${rest}` : ""}${location.hash}`);
}

/** The editor is a separate chunk, loaded only on /edit/:id. */
function Editor({ id }: { id: string }) {
  const [App, setApp] = useState<ComponentType<{ projectId: string }>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    import("./App.js").then(
      (m) => setApp(() => m.App),
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error) return <p class="hint">The editor didn't load: {error}</p>;
  return App ? <App projectId={id} /> : null;
}

const ROUTES: [string, (p: Record<string, string>) => VNode][] = [
  ["/", () => <Home />],
  ["/t/:slug", (p) => <TemplatePage key={p.slug} slug={p.slug!} />],
  ["/decode/:id", (p) => <DecodePage key={p.id} id={p.id!} />],
  ["/p/:id", (p) => <ProjectPage key={p.id} id={p.id!} />],
  ["/edits", () => <ProjectsPage />],
  ["/setup", () => <SetupPage />],
  ["/settings", () => <SettingsPage />],
  ["/edit/:id", (p) => <Editor key={p.id} id={p.id!} />],
];

function Root() {
  const { path } = useRoute();
  for (const [pattern, view] of ROUTES) {
    const params = matchPath(pattern, path);
    if (!params) continue;
    // The editor keeps its own chrome; every other page sits in the app shell.
    if (pattern === "/edit/:id") {
      document.title = "open-katana studio";
      return view(params);
    }
    document.title = "open-katana";
    return <Shell>{view(params)}</Shell>;
  }
  document.title = "open-katana";
  return (
    <Shell>
      <Home />
    </Shell>
  );
}

render(<Root />, document.getElementById("app")!);
