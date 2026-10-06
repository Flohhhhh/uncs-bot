import { z } from "zod";

import type { AdminServer } from "~/lib/admin-servers";
import { serverApiPath } from "~/components/overview/overview-data";

import {
  applicationReviewResponseSchema,
  type ApplicationDecision,
  type ApplicationReviewResponse,
  type WhitelistApplication,
} from "./whitelist-data";

const actionResultSchema = z.object({
  id: z.string().optional(),
  state: z.enum(["applied", "accepted", "pending", "failed", "unknown"]),
  message: z.string(),
});

export type WhitelistActionResult = z.infer<typeof actionResultSchema>;
export type WhitelistActionInput = {
  id: string;
  action: "whitelist-add" | "whitelist-remove";
  steamId: string;
  reason: string;
  confirm?: string;
};

export class WhitelistMutationError extends Error {
  constructor(
    message: string,
    readonly state: "failed" | "unknown",
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function postAdminJson<T>(
  server: AdminServer,
  csrf: string,
  resource: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const path = serverApiPath(server.id, resource);
  if (!path) throw new WhitelistMutationError("The selected server could not be verified.", "failed");

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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new WhitelistMutationError(
      "The connection ended before this action was confirmed. Refresh and check the result before trying again.",
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
    const detail =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "message" in responseBody &&
      typeof responseBody.message === "string"
        ? responseBody.message
        : "The action could not be completed.";
    const knownRefusal = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status);
    const headerWait = Number(response.headers.get("Retry-After"));
    const bodyWait =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "retryAfter" in responseBody &&
      typeof responseBody.retryAfter === "number"
        ? responseBody.retryAfter
        : undefined;
    throw new WhitelistMutationError(
      detail,
      knownRefusal ? "failed" : "unknown",
      response.status,
      Number.isFinite(headerWait) && headerWait > 0 ? headerWait : bodyWait,
    );
  }

  const parsed = schema.safeParse(responseBody);
  if (!parsed.success) {
    throw new WhitelistMutationError(
      "The action response could not be verified. Refresh and check the result before trying again.",
      "unknown",
    );
  }
  return parsed.data;
}

export function sendWhitelistAction({
  server,
  csrf,
  input,
}: {
  server: AdminServer;
  csrf: string;
  input: WhitelistActionInput;
}) {
  return postAdminJson(server, csrf, "actions", input, actionResultSchema);
}

export function sendApplicationReview({
  server,
  csrf,
  application,
  decision,
  reviewId,
  reason,
}: {
  server: AdminServer;
  csrf: string;
  application: Pick<WhitelistApplication, "id">;
  decision: ApplicationDecision;
  reviewId: string;
  reason: string;
}): Promise<ApplicationReviewResponse> {
  return postAdminJson(
    server,
    csrf,
    "applications/" + encodeURIComponent(application.id) + "/" + decision,
    { id: reviewId, reason },
    applicationReviewResponseSchema,
  );
}
