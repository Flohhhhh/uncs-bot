import { createContext, useContext } from "react";
import type { ActionName, Overview, Staff } from "../api/types";
export type SelectedServer = { id: string; name: string; version: string; role: Staff["role"] };
export type AdminContextValue = {
  me: Staff;
  server?: SelectedServer;
  overview: Overview | null;
  stale: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  dialogOpen: boolean;
  setDialogOpen: (value: boolean) => void;
  setUnsavedChanges: (value: boolean) => void;
  refreshVersion: number;
  refresh: () => void;
  invalidateOverview: () => void;
  openAction: (action: ActionName, steamId?: string) => void;
};
export const AdminContext = createContext<AdminContextValue | null>(null);
export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) throw new Error("Admin context is unavailable.");
  return context;
}
export function useGameAdmin() {
  const context = useAdmin();
  return { ...context, me: context.server ? { ...context.me, role: context.server.role } : context.me };
}
