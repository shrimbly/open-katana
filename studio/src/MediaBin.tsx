import { useState } from "preact/hooks";
import { api, type AssetT } from "./api.js";
import type { Editor } from "./store.js";
import { ASSET_MIME } from "./Timeline.js";

const GROUPS: { title: string; test: (a: AssetT) => boolean }[] = [
  { title: "Clips", test: (a) => a.kind === "video" && a.role === "generated" && !/matte|control/i.test(a.label ?? a.id) },
  { title: "Stills", test: (a) => a.kind === "image" && a.role !== "reference" },
  { title: "Your footage", test: (a) => a.kind === "video" && (a.role === "footage" || a.role === "subject") },
  { title: "Reference", test: (a) => a.role === "reference" },
  { title: "Helpers", test: (a) => a.kind === "video" && a.role === "generated" && /matte|control/i.test(a.label ?? a.id) },
  { title: "Audio", test: (a) => a.kind === "audio" },
];

export function MediaBin({ editor }: { editor: Editor }) {
  const { state, edl } = editor;
  const used = new Set(edl?.shots.map((s) => s.source.asset) ?? []);
  const assets = (state?.assets ?? []).filter((a) => a.role !== "render");
  const seen = new Set<string>();
  return (
    <aside class="panel left" aria-label="Media">
      <div class="panel-head">
        <span class="label">Media</span>
        <span class="hint">{assets.length} files</span>
      </div>
      {GROUPS.map((g) => {
        const items = assets.filter((a) => !seen.has(a.id) && g.test(a));
        for (const a of items) seen.add(a.id);
        if (!items.length) return null;
        return (
          <div class="bin-group" key={g.title}>
            <span class="label">{g.title}</span>
            {g.title === "Audio" ? (
              items.map((a) => <AudioItem key={a.id} asset={a} />)
            ) : (
              <div class="bin-grid">
                {items.map((a) => (
                  <AssetCard key={a.id} asset={a} projectId={editor.projectId} used={used.has(a.id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!assets.length && <p class="hint" style={{ padding: "0 14px" }}>No media yet. Clips appear here as the agent generates them.</p>}
    </aside>
  );
}

function AssetCard({ asset, projectId, used }: { asset: AssetT; projectId: string; used: boolean }) {
  const [hover, setHover] = useState(false);
  const verdict = asset.verdict;
  return (
    <button
      type="button"
      class={`asset${used ? " used" : ""}`}
      draggable
      title={`${asset.id}${asset.width ? ` · ${asset.width}×${asset.height}` : ""}${asset.label ? `\n${asset.label}` : ""}\nDrag onto a shot to use it.`}
      onDragStart={(e) => {
        e.dataTransfer!.setData(ASSET_MIME, asset.id);
        e.dataTransfer!.effectAllowed = "copy";
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      {hover && asset.kind === "video" ? (
        <video class="thumb" src={asset.url} muted autoPlay loop playsInline />
      ) : (
        <img class="thumb" src={api.thumb(projectId, asset.id, asset.kind === "video" ? Math.min(0.5, (asset.durationSec ?? 1) / 2) : 0, 160)} alt="" loading="lazy" draggable={false} />
      )}
      {(verdict || used) && <span class={`badge ${verdict ?? ""}`}>{verdict === "reject" ? "Rejected" : verdict === "accept" ? (used ? "In edit" : "Accepted") : "In edit"}</span>}
      <span class="meta">
        <span class="name">{asset.id}</span>
        {asset.kind === "video" && <span class="dur mono">{(asset.durationSec ?? 0).toFixed(1)}s</span>}
      </span>
    </button>
  );
}

function AudioItem({ asset }: { asset: AssetT }) {
  return (
    <div class="audio-asset" draggable onDragStart={(e) => e.dataTransfer!.setData("application/x-katana-audio", asset.id)}>
      <span class="name">{asset.label ?? asset.id}</span>
      <span class="dur mono hint">{(asset.durationSec ?? 0).toFixed(1)}s</span>
    </div>
  );
}
