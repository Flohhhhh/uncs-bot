export const UNNAMED_PLAYER = "Unnamed player";
export function publicName(steamId: string | null | undefined, name: unknown): string {
  const label = typeof name === "string" ? name.trim() : "";
  const identifying = !label || /^\d{17}$/.test(label) || (!!steamId && label.includes(steamId));
  return identifying ? UNNAMED_PLAYER : (name as string);
}
