export type IdentityValue = { available: boolean; value: string | null; error?: string };
export interface ServerIdentity {
  serverId: IdentityValue;
  banner: IdentityValue;
}
