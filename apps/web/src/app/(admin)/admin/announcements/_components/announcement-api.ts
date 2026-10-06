import { z } from "zod";

import type { AdminServer } from "~/lib/admin-servers";
import { serverApiPath } from "~/components/overview/overview-data";

const actionResultSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown"]),
  message: z.string(),
});

export type AnnouncementResult = z.infer<typeof actionResultSchema>;

export class AnnouncementMutationError extends Error {
  constructor(
    message: string,
    readonly state: "failed" | "unknown",
  ) {
    super(message);
  }
}

export async function sendAnnouncement({
  server,
  csrf,
  message,
}: {
  server: AdminServer;
  csrf: string;
  message: string;
}): Promise<AnnouncementResult> {
  const path = serverApiPath(server.id, "actions");
  if (!path) throw new AnnouncementMutationError("The selected server could not be verified.", "failed");

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
      body: JSON.stringify({
        id: crypto.randomUUID(),
        action: "broadcast",
        message,
        reason: "Staff action: Send announcement.",
        serverId: server.id,
        serverVersion: server.version,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AnnouncementMutationError(
      "The connection ended before this announcement was confirmed. Check Audit Logs before trying again.",
      "unknown",
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
        : "The announcement could not be sent.";
    const knownRefusal = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status);
    throw new AnnouncementMutationError(message, knownRefusal ? "failed" : "unknown");
  }

  const parsed = actionResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new AnnouncementMutationError(
      "The announcement response could not be verified. Check Audit Logs before trying again.",
      "unknown",
    );
  }
  return parsed.data;
}
