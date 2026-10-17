import { useEffect, useRef, useState } from "preact/hooks";
import type { ProjectCard } from "../../../../src/app/types.js";
import { ApiError, app } from "../api.js";
import { useApp } from "../Shell.js";
import { CutMap } from "../CutMap.js";
import { cutMapLabel } from "../ProgressView.js";
import { Link, navigate } from "../router.js";
import { Button, Chip, Dialog, MediaBox, toast, useLayer } from "../ui.js";
import { fmtDay, pillText, revealLabel } from "../useRun.js";
import "../run.css";

/**
 * `/edits` (spec §4.11): every project, newest first, with the ones being made or waiting for you
 * pinned on top. Kept current by the shell's global channel (`runs`, `projects`).
 */
type Filter = "all" | "making" | "needs-you" | "ready" | "decoded";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["making", "Making"],
  ["needs-you", "Needs you"],
  ["ready", "Ready"],
  ["decoded", "Decoded"],
];
const PINNED = new Set<ProjectCard["state"]>(["making", "queued", "needs-you"]);
const HELD = PINNED;

const matches = (c: ProjectCard, f: Filter) => f === "all" || c.state === f || (f === "making" && c.state === "queued");
const hrefOf = (c: ProjectCard) => (c.state === "decoded" ? `/decode/${encodeURIComponent(c.id)}` : `/p/${encodeURIComponent(c.id)}`);

export function ProjectsPage() {
  const [list, setList] = useState<ProjectCard[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [menu, setMenu] = useState<string>();
  const [deleting, setDeleting] = useState<ProjectCard>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    app.projects().then(
      (l) => {
        setList(l);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  // The shell's one global channel says when runs or projects change; read the list again then.
  const shared = useApp();
  const runsKey = shared.runs.map((r) => `${r.id}:${r.status}:${Math.round(r.pct)}`).join(",");
  useEffect(() => void load(), [shared.projectsRev, runsKey]);

  /** Closes the open tile menu; `refocus` puts focus back on its ⋯ button (Esc, Tab, Show in Finder, Delete). */
  const closeMenu = (refocus = false) => {
    const id = menu;
    setMenu(undefined);
    if (refocus && id) document.querySelector<HTMLElement>(`[data-menu-for="${CSS.escape(id)}"]`)?.focus();
  };
  useLayer(Boolean(menu), () => closeMenu(true));
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest(".tile-menu")) setMenu(undefined);
    };
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [menu]);

  const sorted = [...(list ?? [])].sort((a, b) => Number(PINNED.has(b.state)) - Number(PINNED.has(a.state)) || b.updatedAt.localeCompare(a.updatedAt));
  const shown = sorted.filter((c) => matches(c, filter));

  const remove = async (c: ProjectCard) => {
    setBusy(true);
    try {
      await app.deleteProject(c.id);
      setDeleting(undefined);
      void load();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? "Stop the edit first." : (e as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="content" class="kt-page edits-page">
      <div class="edits-head">
        <h1 class="kt-display-m">YOUR EDITS</h1>
        {Boolean(list?.length) && (
          <div class="chip-row" role="group" aria-label="Show">
            {FILTERS.map(([f, label]) => (
              <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
                {label}
              </Chip>
            ))}
          </div>
        )}
      </div>
      {error && !list && <p class="kt-error">{error}</p>}
      {list && list.length === 0 && (
        <div class="edits-empty">
          <p>
            <strong>No edits yet.</strong> Your first one takes about 20 minutes.
          </p>
          <div class="row-actions">
            <Link class="btn primary" href="/">
              Browse templates
            </Link>
            <Link class="btn ghost" href="/#decode">
              Decode an edit
            </Link>
          </div>
        </div>
      )}
      {list && list.length > 0 && shown.length === 0 && <p class="kt-fine">Nothing here right now.</p>}
      <ul class="edit-grid">
        {shown.map((c) => {
          const ar = c.aspect ?? 9 / 16;
          return (
            <li key={c.id} class={`edit-tile${ar > 1 ? " wide" : ""}`} style={{ "--ar": String(ar) }}>
              <Link class="edit-tile-link" href={hrefOf(c)}>
                <MediaBox aspect={ar}>
                  {c.poster && <img src={c.poster} alt="" loading="lazy" onError={(e) => (e.currentTarget.hidden = true)} />}
                  <span class={`pill on-media ${c.state}`}>{pillText(c.state, { pct: c.progress?.pct, versions: c.versions })}</span>
                </MediaBox>
                {c.cutMap && <CutMap data={c.cutMap} height={20} label={cutMapLabel(c.cutMap)} />}
                <span class="type-heading edit-title">{c.title}</span>
                <span class="kt-fine mono">{fmtDay(c.updatedAt)}</span>
                {c.origin === "chat" && c.state !== "chat" && <span class="kt-fine">Made in a Claude Code chat</span>}
              </Link>
              <div
                class="tile-menu"
                onFocusOut={(e) => {
                  // Focus moved to something outside this tile's menu (a click elsewhere is the pointer handler's).
                  const to = e.relatedTarget as Node | null;
                  if (menu === c.id && to && !e.currentTarget.contains(to)) setMenu(undefined);
                }}
              >
                <Button
                  variant="ghost"
                  size="small"
                  class="tile-menu-btn"
                  aria-label={`More for ${c.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menu === c.id}
                  data-menu-for={c.id}
                  onClick={() => setMenu((m) => (m === c.id ? undefined : c.id))}
                >
                  ⋯
                </Button>
                {menu === c.id && (
                  <TileMenu
                    card={c}
                    onClose={closeMenu}
                    onDelete={() => {
                      // Focus on ⋯ first, so the dialog gives it back there when it closes.
                      closeMenu(true);
                      setDeleting(c);
                    }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={Boolean(deleting)}
        title={deleting ? `Delete '${deleting.title}'?` : "Delete"}
        onClose={() => setDeleting(undefined)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            {deleting && !HELD.has(deleting.state) && (
              <Button variant="danger" disabled={busy} onClick={() => void remove(deleting)}>
                Delete
              </Button>
            )}
          </>
        }
      >
        <p>{deleting && HELD.has(deleting.state) ? "Stop the edit first." : "Its photos, shots and renders move to ~/.open-katana/trash."}</p>
      </Dialog>
    </main>
  );
}

/**
 * The ⋯ menu of a tile (WAI-ARIA menu button): focus starts on the first item, ↑/↓/Home/End move
 * between items, Esc closes it and Tab leaves it (both put focus back on ⋯ first, so Tab carries on
 * from there to the next tile).
 */
function TileMenu({ card, onClose, onDelete }: { card: ProjectCard; onClose(refocus?: boolean): void; onDelete(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(), []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      // No preventDefault: focus goes to ⋯ now, and the browser's Tab moves on from there.
      onClose(true);
      return;
    }
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : undefined;
    if (to === undefined) return;
    e.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <div class="menu" role="menu" aria-label={`More for ${card.title}`} ref={box} onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => go(hrefOf(card))}>
        Open
      </button>
      {card.state !== "decoded" && (
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => go(`/edit/${encodeURIComponent(card.id)}`)}>
          Open in editor
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          onClose(true);
          void app.reveal(card.id, "folder").catch((e: Error) => toast(e.message, { error: true }));
        }}
      >
        {revealLabel()}
      </button>
      <button type="button" role="menuitem" tabIndex={-1} class="danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
