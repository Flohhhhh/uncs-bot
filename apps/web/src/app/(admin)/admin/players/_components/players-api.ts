import { z } from "zod";

import type { AdminServer } from "~/lib/admin-servers";
import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";

import { playersOverviewSchema, type PlayerAction, type PlayersOverview } from "./players-data";

const actionResultSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown"]),
  message: z.string(),
  changed: z.boolean().optional(),
});

export type PlayerActionResult = z.infer<typeof actionResultSchema>;

export type PlayerActionInput = {
  id: string;
  action: PlayerAction;
  steamId: string;
  reason: string;
  confirm?: string;
  message?: string;
  faction?: string;
  expectedFaction?: string;
  expectedRound?: { map: string; startedAt: number };
};

export class PlayerMutationError extends Error {
  constructor(
    message: string,
    readonly state: "failed" | "unknown",
  ) {
    super(message);
  }
}

export async function readPlayersOverview(server: AdminServer) {
  const path = serverApiPath(server.id, "overview");
  if (!path) throw new Error("The selected server could not be verified.");
  return readAdminApi(path, playersOverviewSchema) as Promise<PlayersOverview>;
}

export async function sendPlayerAction({
  server,
  csrf,
  input,
}: {
  server: AdminServer;
  csrf: string;
  input: PlayerActionInput;
}): Promise<PlayerActionResult> {
  const path = serverApiPath(server.id, "actions");
  if (!path) throw new PlayerMutationError("The selected server could not be verified.", "failed");

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
    throw new PlayerMutationError(
      "The connection ended before this action was confirmed. Do not resend it until the result is checked.",
      "unknown",
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    const message =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "message" in responseBody &&
      typeof responseBody.message === "string"
        ? responseBody.message
        : "The action could not be completed.";
    const knownRefusal = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status);
    throw new PlayerMutationError(message, knownRefusal ? "failed" : "unknown");
  }

  const result = actionResultSchema.safeParse(responseBody);
  if (!result.success) {
    throw new PlayerMutationError(
      "The action response could not be verified. Do not resend it until the result is checked.",
      "unknown",
    );
  }
  return result.data;
}
