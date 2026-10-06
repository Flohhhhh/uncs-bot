import { reconcileResponseSchema, type ReconcileResponse } from "./discord-roles-data";

const endpoint = "/admin/api/discord-roles";

export class DiscordRolesRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export async function reconcileDiscordRoles({
  csrf,
  id,
  reason,
  dryRun,
}: {
  csrf: string;
  id: string;
  reason: string;
  dryRun: boolean;
}): Promise<ReconcileResponse> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/reconcile`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id, reason, ...(dryRun ? { dryRun: true } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new DiscordRolesRequestError(
      dryRun
        ? "The preview did not finish. A preview never changes roles; try it again."
        : "The connection ended before Gramps confirmed the result, so the role check may still have run. Refresh this page and check Recent role changes before running it again.",
      0,
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? body.message
        : "The Discord roles request could not be completed.";
    throw new DiscordRolesRequestError(message, response.status);
  }

  const parsed = reconcileResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DiscordRolesRequestError(
      dryRun
        ? "The preview could not be verified. Try it again."
        : "The role check result could not be confirmed. Refresh first and check Recent role changes.",
      null,
    );
  }
  return parsed.data;
}

export function reconcileError(error: unknown, dryRun: boolean) {
  if (!(error instanceof DiscordRolesRequestError))
    return dryRun
      ? "The preview could not be completed."
      : "The role check result could not be confirmed. Refresh first.";
  const { status } = error;
  if (status === 400) return `Gramps could not read this request. ${error.message}`.trim();
  if (status === 403)
    return "Only administrators can manage Discord roles. Sign in again with an administrator account.";
  if (status === 404) return "This server version has no Discord roles feature yet. Nothing was changed.";
  if (status === 409) return error.message || "A role check is already running. Try again when it finishes.";
  if (status === 429)
    return dryRun
      ? "Gramps allows one preview every 5 seconds. Wait a moment, then preview again."
      : "Gramps allows one role check every 30 seconds. Previews don’t count toward this wait. Wait a moment, then try again.";
  if (status === 503) {
    if (!error.message) return "Discord roles are unavailable right now. No role change was sent.";
    return /no role change/i.test(error.message) ? error.message : `${error.message} No role change was sent.`;
  }
  return (
    error.message ||
    (dryRun ? "The preview could not be completed." : "The role check result could not be confirmed. Refresh first.")
  );
}

export function errorStatus(error: unknown) {
  return error instanceof DiscordRolesRequestError
    ? error.status
    : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : null;
}
