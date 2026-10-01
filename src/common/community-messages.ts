/** Staff-visible settings and observations; never credentials or recipient identities. */
export interface CommunityMessagesStatus {
  enabled: boolean;
  workerStarted: boolean;
  lastObservedAt: string | null;
  lastMessageAcknowledgedAt: string | null;
  lastStatusCardUpdatedAt: string | null;
  welcome: { enabled: boolean; messages: string[]; delaySeconds: number; spacingSeconds: number };
  round: { enabled: boolean; message: string };
  discordStatus: { enabled: boolean; configured: boolean };
}
