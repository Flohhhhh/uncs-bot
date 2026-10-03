import { createContext, useContext } from "react";
import type { ActionName, Overview, Staff } from "../api/types";
export type SelectedServer = { id: string; name: string; version: string; role: Staff["role"] };
/** Optional details for an action review, such as a broadcast message drafted on the page. */
export type ActionOptions = { initialMessage?: string };
export type AdminContextValue = {
  me: Staff;
  server?: SelectedServer;
  overview: Overview | null;
  stale: boolean;
  /** A read of the server details is in flight. */
  checking: boolean;
  /**
   * Asks for the live roster on a page that does not read it, such as Server activity, until the returned
   * function is called. While anything asks, the roster is read now and on every refresh.
   */
  watchRoster: () => () => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  dialogOpen: boolean;
  setDialogOpen: (value: boolean) => void;
  setUnsavedChanges: (value: boolean) => void;
  refreshVersion: number;
  refresh: () => void;
  invalidateOverview: () => void;
  openAction: (action: ActionName, steamId?: string, options?: ActionOptions) => void;
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
