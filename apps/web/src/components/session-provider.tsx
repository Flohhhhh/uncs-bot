"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { initialSession, SessionStore, type SessionState } from "~/lib/session/store";

type SessionContext = SessionState & { refresh: () => Promise<void>; signOut: () => Promise<void> };
const Context = createContext<SessionContext | null>(null);
const serverSnapshot = () => initialSession;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SessionStore());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  useEffect(() => {
    void store.check();
    const recheck = () => {
      if (!document.hidden) void store.check();
    };
    const visibility = () => {
      if (document.hidden) store.pauseChecks();
      else recheck();
    };
    const interval = setInterval(() => {
      if (!document.hidden && store.getSnapshot().status === "authenticated") void store.check();
    }, 30_000);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", visibility);
      store.cancel();
    };
  }, [store]);
  return (
    <Context.Provider value={{ ...state, refresh: store.check, signOut: store.signOut }}>{children}</Context.Provider>
  );
}

export function useSession() {
  const session = useContext(Context);
  if (!session) throw new Error("useSession must be used within SessionProvider");
  return session;
}
