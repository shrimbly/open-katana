import { useEffect, useRef, useState } from "preact/hooks";
import type { Upload } from "../../../src/app/types.js";
import { Icon } from "./ui.js";

/** Step 1 of the make rail: the person's photos (first = face) and the permission tick (spec §4.3). */
export interface PhotoDropProps {
  min: number;
  max: number;
  title: string;
  photos: Upload[];
  /** `preview` is a local blob URL, so the thumbnail shows before the upload finishes. */
  uploading: { name: string; pct: number; preview?: string }[];
  heic: boolean;
  consent: boolean;
  onAdd(files: File[]): void;
  onRemove(id: string): void;
  onReorder(ids: string[]): void;
  onConsent(v: boolean): void;
  /** Uploads the server refused, with its copy (e.g. "Use a JPG, PNG or WebP photo."). */
  errors?: { name: string; message: string }[];
}

const REORDER_TYPE = "application/x-katana-photo";

/** A photo dropped on Home waits here for the next template page (spec §4.2). */
let stashed: File | undefined;
export const stashPhoto = (f: File) => void (stashed = f);
export function takeStashedPhoto(): File | undefined {
  const f = stashed;
  stashed = undefined;
  return f;
}

export function acceptFor(heic: boolean): string {
  return `image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp${heic ? ",image/heic,image/heif,.heic,.heif" : ""}`;
}

export function PhotoDrop(p: PhotoDropProps) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [over, setOver] = useState(false);
  const [dragId, setDragId] = useState<string>();
  const [said, setSaid] = useState("");
  const [note, setNote] = useState("");
  const [focusId, setFocusId] = useState<string>();
  const count = p.photos.length + p.uploading.length;
  const room = Math.max(0, p.max - count);
  const formats = p.heic ? "JPG, PNG, WebP or HEIC" : "JPG, PNG or WebP";

  // Keep focus on a photo after it moves.
  useEffect(() => {
    if (!focusId) return;
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
    setFocusId(undefined);
  }, [focusId, p.photos]);

  const add = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    if (!images.length) return;
    if (images.length > room) setNote(room ? `Up to ${p.max} photos: added the first ${room}.` : `Up to ${p.max} photos. Remove one to add another.`);
    else setNote("");
    if (room) p.onAdd(images.slice(0, room));
  };

  const move = (id: string, to: number) => {
    const ids = p.photos.map((x) => x.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    p.onReorder(ids);
    setSaid(`Photo ${from + 1} moved to position ${to + 1}${to === 0 ? ", face photo" : ""}.`);
    setFocusId(id);
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    const reorder = e.dataTransfer.types.includes(REORDER_TYPE);
    if (!reorder && !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = reorder ? "move" : "copy";
    if (!reorder) setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    if (e.dataTransfer.types.includes(REORDER_TYPE)) return;
    add([...e.dataTransfer.files]);
  };

  const pick = () => input.current?.click();
  const warnings = p.photos.flatMap((ph, i) => ph.checks.filter((c) => c.level !== "ok").map((c) => ({ i, c })));
  const progress = p.uploading.length ? Math.round(p.uploading.reduce((s, u) => s + u.pct, 0) / p.uploading.length) : undefined;

  return (
    <div class={`kt-photos${over ? " over" : ""}`} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <p class="kt-field-label">{p.title}</p>
      <input
        ref={input}
        type="file"
        class="kt-sr"
        tabIndex={-1}
        aria-hidden="true"
        accept={acceptFor(p.heic)}
        multiple={p.max > 1}
        onChange={(e) => {
          add([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
      {count === 0 ? (
        <div class="kt-dropzone">
          <p class="kt-dropzone-title">Drop a photo of you</p>
          <p class="kt-dropzone-text">{p.max > 1 ? `Face clear and sharp. Add a full-body shot for the outfit (up to ${p.max}).` : "Face clear and sharp."}</p>
          <button type="button" class="btn" onClick={pick}>
            <Icon name="upload" size={14} />
            Choose photos
          </button>
          <p class="kt-fine">{formats} · up to 30 MB</p>
        </div>
      ) : (
        <>
          <ul ref={list} class="kt-thumbs" aria-label="Your photos, in order. The first is the face photo.">
            {p.photos.map((ph, i) => (
              <li
                key={ph.id}
                data-id={ph.id}
                class={`kt-thumb${dragId === ph.id ? " dragging" : ""}`}
                tabIndex={0}
                draggable
                aria-label={`Photo ${i + 1}${i === 0 ? ", face photo" : ""}: ${ph.name}${ph.width ? `, ${ph.width} by ${ph.height}` : ""}. Alt and arrow keys move it.`}
                onKeyDown={(e) => {
                  if (!e.altKey) return;
                  if (e.key === "ArrowLeft") move(ph.id, i - 1);
                  else if (e.key === "ArrowRight") move(ph.id, i + 1);
                  else return;
                  e.preventDefault();
                }}
                onDragStart={(e) => {
                  e.dataTransfer?.setData(REORDER_TYPE, ph.id);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                  setDragId(ph.id);
                }}
                onDragEnd={() => setDragId(undefined)}
                onDragOver={(e) => {
                  if (!e.dataTransfer?.types.includes(REORDER_TYPE)) return;
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer?.getData(REORDER_TYPE);
                  if (!id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  move(id, i);
                  setDragId(undefined);
                }}
              >
                <div class="kt-thumb-img">
                  <img src={ph.url} alt="" draggable={false} />
                  {i === 0 && <span class="kt-face">Face</span>}
                  <button type="button" class="kt-thumb-x" aria-label={`Remove ${ph.name}`} onClick={() => p.onRemove(ph.id)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
                {ph.width && ph.height ? (
                  <span class="kt-thumb-dims mono">
                    {ph.width}×{ph.height}
                  </span>
                ) : null}
              </li>
            ))}
            {p.uploading.map((u, i) => (
              <li key={`up-${i}`} class="kt-thumb uploading" aria-hidden="true">
                <div class="kt-thumb-img">
                  {u.preview && <img src={u.preview} alt="" />}
                  {p.photos.length === 0 && i === 0 && <span class="kt-face">Face</span>}
                  <span class="kt-thumb-bar" style={{ transform: `scaleX(${Math.max(0.04, u.pct / 100)})` }} />
                </div>
              </li>
            ))}
            {room > 0 && (
              <li class="kt-thumb add">
                <button type="button" class="kt-thumb-add" onClick={pick} aria-label={`Add photos (up to ${p.max})`}>
                  <Icon name="plus" />
                </button>
              </li>
            )}
          </ul>
          {progress !== undefined && (
            <p class="kt-upload-line">
              Uploading photo… <span class="mono">{progress}%</span>
            </p>
          )}
          {p.photos.length > 1 && <p class="kt-fine">Drag to reorder, or focus a photo and press Alt+← or Alt+→. The first photo is the face.</p>}
        </>
      )}
      {warnings.length > 0 && (
        <ul class="kt-checks">
          {warnings.map(({ i, c }) => (
            <li key={`${i}-${c.id}`} class={c.level}>
              <Icon name="warn" size={13} />
              <span>
                {p.photos.length > 1 && <span class="mono">Photo {i + 1} · </span>}
                {c.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(p.errors ?? []).map((e) => (
        <p key={e.name} class="kt-error" role="alert">
          <span class="mono">{e.name}</span>: {e.message}
        </p>
      ))}
      {note && <p class="kt-fine">{note}</p>}
      <label class="kt-check consent">
        <input type="checkbox" checked={p.consent} required onChange={(e) => p.onConsent(e.currentTarget.checked)} />
        <span>This is me, or I have permission from the person in these photos.</span>
      </label>
      <span class="kt-sr" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}
