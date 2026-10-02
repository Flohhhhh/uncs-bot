/** Staff-visible settings and observations; never credentials or recipient identities. */
export interface CommunityMessagesStatus {
  enabled: boolean;
  workerStarted: boolean;
  lastObservedAt: string | null;
  lastMessageAcknowledgedAt: string | null;
  lastStatusCardUpdatedAt: string | null;
  welcome: {
    enabled: boolean;
    /** The first configured welcome sequence; kept for dashboards that predate variants. */
    messages: string[];
    /** Every configured sequence. Each observed join gets one at random, never that player's previous one. */
    variants?: string[][];
    /**
     * Sequences for joiners on that server's running whitelist, chosen the same way with their own history.
     * Null when unset: every joiner then gets `variants`.
     */
    whitelistedVariants?: string[][] | null;
    /** How whitelist membership is read for `whitelistedVariants`; null when they are unset. */
    whitelist?: {
      /** The game's running whitelist (reserved slots), not the saved configuration. */
      source: "running-whitelist";
      /** A read is reused for this long; whitelist changes made through Gramps refresh it sooner. */
      cacheSeconds: number;
      /** When the list behind the latest whitelist-aware choice was read; null before the first. */
      lastLoadedAt: string | null;
      /** The latest failed read. Joiners get `variants` for a minute after one. */
      lastFailedAt: string | null;
    } | null;
    delaySeconds: number;
    spacingSeconds: number;
  };
  round: {
    enabled: boolean;
    /** The first configured round message; kept for dashboards that predate rotation. */
    message: string;
    /** Every configured round message. One is chosen at random per round, never the previous round's. */
    messages?: string[];
  };
  discordStatus: { enabled: boolean; configured: boolean };
}
