import { useState } from "preact/hooks";
import type { TemplateCard } from "../../../src/app/types.js";
import { TemplateTile } from "./TemplateTile.js";
import { Chip } from "./ui.js";

/**
 * The template gallery (spec §4.2): justified rows where 9:16, 4:3 and 16:9 tiles share a row height
 * uncropped, filter chips (Yours only once a user template exists) and the count.
 */

type Filter = "all" | "shot-for-shot" | "freestyle" | "yours";
const FILTER_KEY = "katana-gallery-filter";

function rememberedFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "shot-for-shot" || v === "freestyle" || v === "yours" ? v : "all";
  } catch {
    return "all";
  }
}

export function Gallery({ templates, error }: { templates?: TemplateCard[]; error?: string }) {
  const [filter, setFilterState] = useState<Filter>(rememberedFilter);
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      // A per-viewer convenience only.
    }
  };
  const all = templates ?? [];
  const hasYours = all.some((t) => t.source === "user");
  const active = filter === "yours" && !hasYours ? "all" : filter;
  // User templates first, then built-ins by title (the server's order, kept stable here).
  const sorted = [...all].sort((a, b) => (a.source === b.source ? 0 : a.source === "user" ? -1 : 1));
  const list = sorted.filter((t) => active === "all" || (active === "yours" ? t.source === "user" : t.kind === active));

  return (
    <section class="kt-gallery-section" aria-labelledby="templates">
      <div class="kt-section-head">
        <h2 id="templates" class="kt-section-title" tabIndex={-1}>
          Templates
        </h2>
        {templates && all.length > 0 && (
          <div class="kt-filters" role="group" aria-label="Show">
            <Chip selected={active === "all"} onClick={() => setFilter("all")}>
              All
            </Chip>
            <Chip selected={active === "shot-for-shot"} onClick={() => setFilter("shot-for-shot")}>
              Shot-for-shot
            </Chip>
            <Chip selected={active === "freestyle"} onClick={() => setFilter("freestyle")}>
              Freestyle
            </Chip>
            {hasYours && (
              <Chip selected={active === "yours"} onClick={() => setFilter("yours")}>
                Yours
              </Chip>
            )}
          </div>
        )}
        <span class="kt-section-rule" aria-hidden="true" />
        {templates && all.length > 0 && (
          <span class="kt-gallery-count" aria-live="polite">
            <span class="mono">{list.length}</span> {list.length === 1 ? "template" : "templates"}
          </span>
        )}
      </div>
      {error ? (
        <p class="kt-empty">{error}</p>
      ) : !templates ? (
        <ul class="kt-gallery" aria-hidden="true">
          {[0.5625, 0.5625, 1.333, 0.5625, 1.778, 0.5625, 0.5625].map((ar, i) => (
            <li key={i} class="kt-tile placeholder" style={{ "--ar": String(ar) }}>
              <div class="kt-tile-media" style={{ aspectRatio: String(ar) }} />
            </li>
          ))}
        </ul>
      ) : all.length === 0 ? (
        <p class="kt-empty">No templates found. Reinstall open-katana, or add one to ~/.open-katana/presets.</p>
      ) : (
        <ul class="kt-gallery">
          {list.map((t) => (
            <TemplateTile key={t.slug} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
