import { useCallback, useEffect, useState } from "preact/hooks";
import type { DecodeState, ProjectEvent, ProjectPageData, RunState } from "../../../src/app/types.js";
import { ApiError, app, MOCK } from "./api.js";

/**
 * The decode page's live data: the `DecodeState` (phases, stats, Cut Map) from
 * `GET /api/projects/:id/decode` and the project channel's `decode` events, plus the project page for the
 * make sheet (brief fields, an existing run). With `?mock=1&fixture=<name>` a fixture stands in
 * (running, ready, done, no-audio, error).
 */
export interface DecodeView {
  state?: DecodeState;
  page?: ProjectPageData;
  /** A run started from this decode, if any (then the page links to its progress). */
  run?: RunState;
  error?: string;
  notFound: boolean;
  reload(): Promise<void>;
}

export function useDecode(id: string): DecodeView {
  const [state, setState] = useState<DecodeState>();
  const [page, setPage] = useState<ProjectPageData>();
  const [run, setRun] = useState<RunState>();
  const [error, setError] = useState<string>();
  const [notFound, setNotFound] = useState(false);

  const reload = useCallback(async () => {
    try {
      const fixture = MOCK ? new URLSearchParams(location.search).get("fixture") : null;
      if (fixture) {
        const f = await import("./fixtures/run.js");
        setState(f.fixtureDecode(fixture));
        setPage(f.decodedPage);
        return;
      }
      const [s, p] = await Promise.all([app.decodeState(id), app.page(id).catch(() => undefined)]);
      setState(s);
      setPage(p);
      setRun(p?.run);
      setError(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setState(undefined);
    setPage(undefined);
    setRun(undefined);
    setNotFound(false);
    void reload();
    return app.projectEvents(
      id,
      (e) => {
        if (e.type === "decode") setState((e as Extract<ProjectEvent, { type: "decode" }>).state);
        else if (e.type === "run") setRun((e as Extract<ProjectEvent, { type: "run" }>).state);
      },
      { onOpen: () => void reload() },
    );
  }, [id, reload]);

  return { state, page, run, error, notFound, reload };
}
