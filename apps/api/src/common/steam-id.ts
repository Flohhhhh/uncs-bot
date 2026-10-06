// Public universe (1), individual account (1), default desktop instance (1),
// and a nonzero uint32 account ID. This checks structure, not account ownership.
// Valve: source-sdk-2013/src/public/steam/steamclientpublic.h (CSteamID::IsValid).
export function isPublicIndividualSteamId(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 17 || !/^[0-9]{17}$/.test(value)) return false;
  const id = BigInt(value);
  return id >= 76561197960265729n && id <= 76561202255233023n;
}
