import type { AnchorHTMLAttributes, TargetedMouseEvent } from "preact";
import { useEffect, useState } from "preact/hooks";

/** Client routing over the History API: `/t/:slug`, `/p/:id`, … all served by the same page. */

export interface RouteState {
  path: string;
  query: URLSearchParams;
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
addEventListener("popstate", notify);

const current = (): RouteState => ({ path: location.pathname, query: new URLSearchParams(location.search) });

/** Goes to an app URL without reloading. Screen changes are hard cuts, so the page starts at the top. */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  scrollTo(0, 0);
  notify();
}

/** The current path and query; re-renders on navigate() and on back/forward. */
export function useRoute(): RouteState {
  const [state, setState] = useState(current);
  useEffect(() => {
    const update = () => setState(current());
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  return state;
}

/** Matches "/t/:slug" against a path; returns the decoded named parts, or undefined. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, p] of want.entries()) {
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(have[i]!);
      } catch {
        return undefined;
      }
    } else if (p !== have[i]) return undefined;
  }
  return params;
}

/** An anchor that navigates in-app on a plain click; modified clicks (new tab, …) behave as usual. */
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: TargetedMouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (props.target && props.target !== "_self") return;
    const url = new URL(props.href, location.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  };
  return <a {...props} onClick={onClick} />;
}
