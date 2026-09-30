import { createContext, useContext } from "react";
import type { ActionName, Overview, Staff } from "../api/types";
export type AdminContextValue = {
  me: Staff;
  overview: Overview | null;
  stale: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  dialogOpen: boolean;
  setDialogOpen: (value: boolean) => void;
  refreshVersion: number;
  refresh: () => void;
  invalidateOverview: () => void;
  notify: (message: string, kind?: string) => void;
  openAction: (action: ActionName, steamId?: string) => void;
};
export const AdminContext = createContext<AdminContextValue | null>(null);
export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) throw new Error("Admin context is unavailable.");
  return context;
}
