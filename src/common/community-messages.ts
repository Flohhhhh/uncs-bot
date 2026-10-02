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
