import { useEffect, useState } from "preact/hooks";

/**
 * The playback clock. The viewer's video is the master while it has one; without a render the
 * clock still runs (silently) so text and timing can be previewed.
 */
export class Clock {
  time = 0;
  playing = false;
  duration = 0;
  fps = 24;
  private video: HTMLVideoElement | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;
  private wallStart = 0;
  private timeStart = 0;
  private stopAt: number | null = null;

  attach(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video) {
      video.currentTime = Math.min(this.time + 1e-3, Math.max(0, (video.duration || this.duration) - 1e-3));
      if (this.playing) void video.play().catch(() => undefined);
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get frame(): number {
    return Math.floor(this.time * this.fps + 1e-6);
  }

  seek(t: number): void {
    this.time = Math.min(Math.max(0, t), Math.max(0, this.duration - 1 / this.fps));
    this.timeStart = this.time;
    this.wallStart = performance.now();
    // A hair past the frame's start so the decoder never lands on the previous frame.
    if (this.video) this.video.currentTime = this.time + 1e-3;
    this.emit();
  }

  seekFrame(frame: number): void {
    this.seek(frame / this.fps);
  }

  play(until?: number): void {
    if (this.time >= this.duration - 1 / this.fps) this.seek(0);
    this.stopAt = until ?? null;
    this.playing = true;
    this.wallStart = performance.now();
    this.timeStart = this.time;
    if (this.video) void this.video.play().catch(() => undefined);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.stopAt = null;
    this.video?.pause();
    cancelAnimationFrame(this.raf);
    if (this.video) this.time = this.video.currentTime;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private tick = () => {
    if (!this.playing) return;
    const v = this.video;
    this.time = v && v.readyState >= 2 ? v.currentTime : this.timeStart + (performance.now() - this.wallStart) / 1000;
    if ((this.stopAt !== null && this.time >= this.stopAt) || this.time >= this.duration || (v?.ended ?? false)) {
      this.pause();
      if (this.time >= this.duration) this.seek(Math.max(0, this.duration - 1 / this.fps));
      return;
    }
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** Re-renders the calling component on every clock change. */
export function useClock(clock: Clock): Clock {
  const [, setTick] = useState(0);
  useEffect(() => clock.subscribe(() => setTick((n) => n + 1)), [clock]);
  return clock;
}
