"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { AdminServer } from "~/lib/admin-servers";

const AdminServerContext = createContext<AdminServer | null>(null);
const AdminGameModeContext = createContext<"live" | "sample" | undefined>(undefined);

export function AdminServerProvider({
  server,
  gameMode,
  children,
}: {
  server: AdminServer;
  gameMode?: "live" | "sample";
  children: ReactNode;
}) {
  return (
    <AdminGameModeContext.Provider value={gameMode}>
      <AdminServerContext.Provider value={server}>{children}</AdminServerContext.Provider>
    </AdminGameModeContext.Provider>
  );
}

export function useSelectedAdminServer() {
  return useContext(AdminServerContext);
}

export function useAdminGameMode() {
  return useContext(AdminGameModeContext);
}
