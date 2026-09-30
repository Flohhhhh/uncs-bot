import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "../app/context";
import { api } from "./client";
export function useResource<T>(path: string | null) {
  const { refreshVersion } = useAdmin();
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
    setResult((previous) => ({ path, data: previous.path === path ? previous.data : null, loading: true, error: "" }));
    void api<T>(path, { signal: controller.signal })
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
  }, [path, refreshVersion, version]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return {
    data: result.path === path ? result.data : null,
    loading: result.path !== path || result.loading,
    error: result.path === path ? result.error : "",
    refresh,
  };
}
