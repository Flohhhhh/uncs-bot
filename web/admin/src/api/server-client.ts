import { useCallback } from "react";
import { api } from "./client";
import { useAdmin } from "../app/context";

/** Captures a selected server for the lifetime of a read/review; never consults a mutable global selection. */
export function useGameApi(): typeof api {
  const { server } = useAdmin();
  return useCallback(
    <T>(path: string, options: RequestInit = {}) => {
      if (!server) return api<T>(path, options); // Legacy test/embedded contexts use the guarded legacy routes.
      const headers = new Headers(options.headers);
      headers.set("X-UNCs-Server-Version", server.version);
      return api<T>(`servers/${server.id}/${path}`, { ...options, headers });
    },
    [server],
  );
}
export function isGameResource(path: string | null) {
  return (
    !!path &&
    /^(overview|bans|whitelist|catalog|rotation|audit|game-log|community-messages|settings|events|map-votes|combat|applications)(\/|\?|$)/.test(
      path,
    )
  );
}
