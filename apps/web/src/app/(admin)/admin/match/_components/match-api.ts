import { z } from "zod";

import type { AdminServer } from "~/lib/admin-servers";
import { serverApiPath } from "~/components/overview/overview-data";

const actionResultSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown"]),
  message: z.string(),
});

export class MatchMutationError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

export async function sendMatchAction({
  server,
  csrf,
  input,
}: {
  server: AdminServer;
  csrf: string;
  input: Record<string, unknown>;
}) {
  const path = serverApiPath(server.id, "actions");
  if (!path) throw new MatchMutationError("The selected server could not be verified.");

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        "X-UNCs-Server-Version": server.version,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new MatchMutationError(
      "The connection ended before this action was confirmed. Refresh and check its result before trying again.",
      true,
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
        : "The match action could not be completed.";
    throw new MatchMutationError(
      message,
      ![400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status),
    );
  }

  const parsed = actionResultSchema.safeParse(body);
  if (!parsed.success)
    throw new MatchMutationError("The action response could not be verified. Refresh before trying again.", true);
  return parsed.data;
}
