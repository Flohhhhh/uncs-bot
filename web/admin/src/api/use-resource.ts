import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../app/context";
import { api } from "./client";
import { isGameResource, useGameApi } from "./server-client";
export function useResource<T>(path: string | null) {
  const { refreshVersion } = useAdmin();
  const gameApi = useGameApi();
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({
    path,
    data: null,
    loading: true,
    error: "",
  });
  useEffect(() => {
    const controller = new AbortController();
    if (!path) {
      setResult({ path, data: null, loading: false, error: "" });
      return;
    }
    setResult((previous) => ({
      path,
      data: previous.path === path ? previous.data : null,
      loading: true,
      error: previous.path === path ? previous.error : "",
    }));
    void (isGameResource(path) ? gameApi : api)<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ path, data, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            path,
            data: previous.path === path ? previous.data : null,
            loading: false,
            error: error instanceof Error ? error.message : "Unable to load this page.",
          }));
      });
    return () => controller.abort();
  }, [path, refreshVersion, version, gameApi]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const current = result.path === path;
  return {
    data: current ? result.data : null,
    // A first load has nothing to show yet. A background refresh keeps the last data on screen,
    // so edit controls stay usable; anything that must wait for the new read checks `refreshing`.
    loading: !current || (result.loading && result.data === null),
    refreshing: current && result.loading && result.data !== null,
    error: current ? result.error : "",
    refresh,
  };
}
