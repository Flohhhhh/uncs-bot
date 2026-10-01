export class RconError extends Error {
  constructor(
    message: string,
    readonly unknownResult = false,
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
