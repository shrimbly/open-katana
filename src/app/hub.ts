import type { ServerResponse } from "node:http";
import type { GlobalEvent, ProjectEvent } from "./types.js";

/** Clients per channel; a new one past this closes the oldest. */
const MAX_CLIENTS = 16;

/**
 * Server-sent events: one channel per project (/api/projects/:id/events, the editor's own events plus
 * run, decode and export events) and one global channel (/api/events). Every channel gets a `: hb`
 * comment every 15 s so proxies and sleeping laptops notice dead connections. Ids are validated by the
 * routes before they subscribe.
 */
export class Hub {
  private readonly projects = new Map<string, Set<ServerResponse>>();
  private readonly globals = new Set<ServerResponse>();
  private timer?: NodeJS.Timeout;
  private readonly heartbeatMs: number;

  constructor(opts: { heartbeatMs?: number } = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
  }

  project(id: string, e: ProjectEvent | Record<string, unknown>): void {
    this.send(this.projects.get(id), e);
  }

  global(e: GlobalEvent): void {
    this.send(this.globals, e);
  }

  subscribeProject(id: string, res: ServerResponse): void {
    let set = this.projects.get(id);
    if (!set) {
      set = new Set();
      this.projects.set(id, set);
    }
    this.open(set, res, () => {
      if (set.size === 0) this.projects.delete(id);
    });
  }

  subscribeGlobal(res: ServerResponse): void {
    this.open(this.globals, res);
  }

  /** Clients on a project channel (tests and diagnostics). */
  count(id?: string): number {
    return id === undefined ? this.globals.size : (this.projects.get(id)?.size ?? 0);
  }

  /** Ends every stream and stops the heartbeat. */
  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const set of [this.globals, ...this.projects.values()]) {
      for (const res of set) res.end();
      set.clear();
    }
    this.projects.clear();
  }

  private open(set: Set<ServerResponse>, res: ServerResponse, onEmpty?: () => void): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    // Sets iterate in insertion order, so the first entry is the oldest client.
    while (set.size >= MAX_CLIENTS) {
      const oldest = set.values().next().value!;
      set.delete(oldest);
      oldest.end();
    }
    set.add(res);
    res.on("close", () => {
      set.delete(res);
      if (set.size === 0) onEmpty?.();
      this.stopIdleTimer();
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
      this.timer.unref();
    }
  }

  private send(set: Set<ServerResponse> | undefined, e: unknown): void {
    if (!set?.size) return;
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of set) res.write(line);
  }

  private heartbeat(): void {
    for (const set of [this.globals, ...this.projects.values()]) for (const res of set) res.write(": hb\n\n");
  }

  private stopIdleTimer(): void {
    if (this.globals.size === 0 && this.projects.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
