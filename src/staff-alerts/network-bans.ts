import { Injectable } from "@nestjs/common";
import { EnvService } from "../env/env.service";
import { staffAlertsOptions } from "./staff-alerts.config";

/**
 * A place Gramps can ask whether joining players carry network bans. Lookups only: a source never
 * bans, kicks or holds a ban to apply later. There is no remote WarDogs source: no documented,
 * permitted ban API exists, so Gramps sends nothing to wardogsbot.com and stores no wdp_/wdk_ key.
 */
export interface NetworkBanSource {
  /** Shown to staff, for example "Staff watch list". */
  readonly name: string;
  lookup(steamIds: string[], signal: AbortSignal): Promise<Map<string, NetworkBanEntry>>;
}
export type NetworkBanEntry = {
  steamId: string;
  communities: number | null;
  reasons: string[];
  evidenceUrls: string[];
  recordedAt: string | null;
  source: "wardogs-network" | "staff";
  revoked?: boolean;
  /** Who added a staff watch-list entry. */
  addedBy?: string | null;
};
/** Provider array of NetworkBanSource. */
export const NETWORK_BAN_SOURCES = Symbol("NETWORK_BAN_SOURCES");

/**
 * STAFF_ALERTS_WATCHLIST: entries staff copy by hand from the WarDogs network alerts in the private
 * staff channel. Adding one means a redeploy. Matches are monitoring only.
 */
@Injectable()
export class EnvWatchlistSource implements NetworkBanSource {
  readonly name = "Staff watch list";
  constructor(private readonly env: EnvService) {}

  lookup(steamIds: string[], signal: AbortSignal): Promise<Map<string, NetworkBanEntry>> {
    if (signal.aborted) return Promise.reject(new Error("The lookup was cancelled."));
    const options = staffAlertsOptions(this.env).watchlist;
    const found = new Map<string, NetworkBanEntry>();
    if (!options.enabled) return Promise.resolve(found);
    const wanted = new Set(steamIds);
    for (const entry of options.entries) {
      if (!wanted.has(entry.steamId)) continue;
      found.set(entry.steamId, {
        steamId: entry.steamId,
        communities: entry.communities ?? null,
        reasons: [entry.reason],
        evidenceUrls: entry.evidenceUrl ? [entry.evidenceUrl] : [],
        recordedAt: entry.recordedAt ?? null,
        source: entry.source ?? "wardogs-network",
        addedBy: entry.addedBy ?? null,
      });
    }
    return Promise.resolve(found);
  }
}

/** Resolves within `ms` or rejects; the signal tells the source to stop. Uses timers jest can fake. */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (error) {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("failed"));
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}
