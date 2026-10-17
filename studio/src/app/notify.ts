import type { RunState } from "../../../src/app/types.js";

/**
 * "Notify me when it's ready" (spec §4.8, D38): the browser's Notification API, permission asked only
 * when the box is ticked. The choice is a per-viewer convenience kept in localStorage; it notifies on
 * done, needs-you and failure.
 */

const KEY = "katana-notify";

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-50)));
  } catch {
    // Storage blocked: the tick lasts for this page only.
  }
}

export const notifySupported = () => typeof Notification !== "undefined";

/** True when this viewer asked to be told about the project and the browser still allows it. */
export function notifyWanted(project: string): boolean {
  return notifySupported() && Notification.permission === "granted" && read().includes(project);
}

/** Ticks or unticks the box; asks for permission on the first tick. Resolves to the resulting state. */
export async function setNotify(project: string, on: boolean): Promise<boolean> {
  const list = read().filter((p) => p !== project);
  if (!on || !notifySupported()) {
    write(list);
    return false;
  }
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") {
    write(list);
    return false;
  }
  write([...list, project]);
  return true;
}

/** Notifies when a watched run reaches done, needs-you or a failure; call with every new snapshot. */
export function notifyRunChange(prev: RunState | undefined, next: RunState): void {
  if (!prev || prev.id !== next.id || prev.status === next.status || !notifyWanted(next.project)) return;
  const body =
    next.status === "done" ? "Your edit is ready." : next.status === "paused" ? "Your edit needs you." : next.status === "failed" ? "Your edit stopped. Everything made so far is saved." : undefined;
  if (!body) return;
  try {
    const n = new Notification(next.title, { body, tag: `katana-${next.id}` });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the page still shows the state.
  }
}
