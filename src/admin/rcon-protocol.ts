/**
 * Why a game request failed, for observers that must not treat every failure alike (staff alerts):
 * unreachable (no answer), rejected (401/403), paused (Retry-After hold or 429), unreadable (not
 * JSON) or error (any other refusal). Never carries upstream text.
 */
export type RconErrorKind = "unreachable" | "rejected" | "paused" | "unreadable" | "error";
export class RconError extends Error {
  constructor(
    message: string,
    readonly unknownResult = false,
    readonly kind?: RconErrorKind,
  ) {
    super(message);
  }
}
const hasProblems = (value: unknown) => value === true || (Array.isArray(value) && value.length > 0);
export function rejected(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const response = result as Record<string, unknown>;
  return (
    response.ok === false ||
    !!response.error ||
    hasProblems(response.errors) ||
    hasProblems(response.conflict) ||
    hasProblems(response.stripped)
  );
}
