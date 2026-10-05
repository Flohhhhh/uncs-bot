"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { AdminServer } from "~/lib/admin-servers";

const AdminServerContext = createContext<AdminServer | null>(null);

export function AdminServerProvider({ server, children }: { server: AdminServer; children: ReactNode }) {
  return <AdminServerContext.Provider value={server}>{children}</AdminServerContext.Provider>;
}

export function useSelectedAdminServer() {
  return useContext(AdminServerContext);
}
