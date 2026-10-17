import { useEffect, useRef, useState } from "preact/hooks";
import type { TemplateCard } from "../../../src/app/types.js";
import { fmtSeconds, useMediaTime } from "./beat.js";
import { templateLength } from "./copy.js";
import { CutMap } from "./CutMap.js";
import { crossedAny, edgeFlashTimes, useReducedMotion } from "./flash.js";
import { useFitText, useTitleStyle } from "./fontsDisplay.js";
import { Link } from "./router.js";
import { Icon } from "./ui.js";

/**
 * One template in the gallery (spec §4.2): the example at its true aspect (or a typographic card
 * until examples ship), the title in the template's own font over a scrim, its Cut Map and one meta
 * line. Hover or focus plays the example muted after 180 ms; the tile's edge flashes on the
 * example's own flash frames, never more than once per 333 ms.
 */

export const KIND_LABEL: Record<TemplateCard["kind"], string> = { "shot-for-shot": "Shot-for-shot", freestyle: "Freestyle" };

/** "49 shots, 7 flashes, 144 beats per minute, 16.4 seconds" for a Cut Map's aria-label. */
export function cutMapLabel(t: Pick<TemplateCard, "cutMap" | "stats" | "kind">): string {
  const m = t.cutMap;
  const parts = [
    m.shots.length ? `${m.shots.length} shots` : `${m.sketch?.length ?? 0}-part recipe`,
    m.flashes.length ? `${m.flashes.length} flashes` : undefined,
    t.stats.bpm ? `${Math.round(t.stats.bpm)} beats per minute` : undefined,
    `${fmtSeconds(m.durationSec).replace(" s", "")} seconds`,
  ];
  return parts.filter(Boolean).join(", ");
}

/** The large title of a template card, fitted to the box in the template's own face. */
export function TemplateTitle({
  t,
  maxPx,
  maxLines = 3,
  maxHeight,
  class: cls,
}: {
  t: Pick<TemplateCard, "title" | "titleStyle">;
  maxPx: number;
  maxLines?: number;
  maxHeight?: number;
  class?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const style = useTitleStyle(t.titleStyle);
  useFitText(ref, { maxPx, maxLines, maxHeight, deps: [style.fontFamily, t.title] });
  return (
    <span ref={ref} class={["kt-title-face", cls].filter(Boolean).join(" ")} style={style}>
      {t.title}
    </span>
  );
}

/** The stand-in for an example that hasn't been rendered yet: title, map in the accent, grain. */
export function TypeCard({ t, big = false }: { t: TemplateCard; big?: boolean }) {
  return (
    <div class={`kt-typecard kt-grain${big ? " big" : ""}`}>
      <span class="label kt-typecard-label">Example coming soon</span>
      <div class="kt-typecard-map" aria-hidden="true">
        <CutMap data={t.cutMap} height={20} label="" tint={t.titleStyle.color} />
      </div>
      <TemplateTitle t={t} maxPx={big ? 132 : 84} maxHeight={0.4} class="kt-typecard-title" />
    </div>
  );
}

export function TemplateTile({ t }: { t: TemplateCard }) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const intent = useRef<ReturnType<typeof setTimeout>>();
  const [playing, setPlaying] = useState(false);
  const [edge, setEdge] = useState(false);
  const time = useMediaTime(video, playing);
  const example = t.media.example;
  const metaId = `tile-${t.slug}-meta`;

  const play = () => {
    const v = video.current;
    if (!v) return;
    void v.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  };
  const stop = () => {
    clearTimeout(intent.current);
    const v = video.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
    setPlaying(false);
  };
  const hoverStart = () => {
    if (!example || reduced) return;
    clearTimeout(intent.current);
    intent.current = setTimeout(play, 180);
  };
  useEffect(() => () => clearTimeout(intent.current), []);

  // Edge flash on the example's own flash frames while it plays.
  useEffect(() => {
    const v = video.current;
    if (!playing || reduced || !v) return;
    const times = edgeFlashTimes(t.cutMap.flashes);
    if (!times.length) return;
    let prev = v.currentTime;
    let frame = 0;
    let off: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const now = v.currentTime;
      if (crossedAny(times, prev, now)) {
        setEdge(true);
        clearTimeout(off);
        off = setTimeout(() => setEdge(false), 80);
      }
      prev = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(off);
      setEdge(false);
    };
  }, [playing, reduced, t.cutMap.flashes]);

  // The same length the template page, its player and the Cut Map show.
  const dur = templateLength(t);
  return (
    <li
      class={`kt-tile${t.format.aspectValue > 1 ? " wide" : ""}${edge ? " edge" : ""}${playing ? " playing" : ""}`}
      style={{ "--ar": String(t.format.aspectValue) }}
      onPointerEnter={hoverStart}
      onPointerLeave={reduced ? undefined : stop}
      onFocusCapture={hoverStart}
      onBlurCapture={reduced ? undefined : stop}
    >
      <div class="kt-tile-media" style={{ aspectRatio: String(t.format.aspectValue) }}>
        {example || t.media.poster ? (
          <>
            {t.media.poster && <img class="kt-media-poster" src={t.media.poster} alt="" decoding="async" />}
            {example && <video ref={video} src={example} poster={t.media.poster} muted loop playsInline preload="none" />}
            <div class="kt-scrim" />
            <TemplateTitle t={t} maxPx={40} maxLines={2} class="kt-tile-title" />
          </>
        ) : (
          <TypeCard t={t} />
        )}
        <div class="kt-tile-badges">{t.source === "user" && <span class="kt-badge yours">Yours</span>}</div>
      </div>
      <div class="kt-tile-map">
        <CutMap data={t.cutMap} height={20} label={cutMapLabel(t)} currentTime={playing ? time : undefined} />
      </div>
      <p class="kt-tile-meta" id={metaId}>
        <span class="mono">{t.format.aspect}</span>
        <span aria-hidden="true"> · </span>
        <span>
          <span class="mono">{Math.round(dur)}</span> s
        </span>
        <span aria-hidden="true"> · </span>
        <span>{KIND_LABEL[t.kind]}</span>
        {t.flashing && (
          <span class="kt-flashing">
            <Icon name="bolt" size={12} />
            Contains flashing
          </span>
        )}
      </p>
      <Link class="kt-tile-link" href={`/t/${encodeURIComponent(t.slug)}`} aria-describedby={metaId}>
        <span class="kt-sr">{t.title}</span>
      </Link>
      {example && reduced && (
        <button
          type="button"
          class="kt-tile-play btn icon-btn"
          aria-label={playing ? `Pause the ${t.title} example` : `Play the ${t.title} example`}
          onClick={() => (playing ? stop() : play())}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
      )}
    </li>
  );
}
