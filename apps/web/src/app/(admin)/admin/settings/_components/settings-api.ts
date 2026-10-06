import type { AdminServer } from "~/lib/admin-servers";
import { serverApiPath } from "~/components/overview/overview-data";

import {
  settingsActionResultSchema,
  settingsSnapshotSchema,
  type SettingsActionResult,
  type SettingsChanges,
} from "./settings-data";

export class SettingsReadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export async function readServerSettings(path: string) {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SettingsReadError(
      "The settings request could not reach the server. Check the dashboard connection and retry.",
      null,
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
        : "The saved server settings could not be read.";
    throw new SettingsReadError(message, response.status);
  }

  const parsed = settingsSnapshotSchema.safeParse(body);
  if (!parsed.success) throw new SettingsReadError("The backend returned settings this page could not verify.", null);
  return parsed.data;
}

export class SettingsMutationError extends Error {
  constructor(
    message: string,
    readonly state: "failed" | "unknown",
  ) {
    super(message);
  }
}

export async function saveServerSettings({
  server,
  csrf,
  id,
  revision,
  changes,
}: {
  server: AdminServer;
  csrf: string;
  id: string;
  revision: string;
  changes: SettingsChanges;
}): Promise<SettingsActionResult> {
  const path = serverApiPath(server.id, "actions");
  if (!path) throw new SettingsMutationError("The selected server could not be verified.", "failed");

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
        id,
        action: "settings-save",
        reason: "Staff reviewed server changes.",
        serverId: server.id,
        serverVersion: server.version,
        revision,
        changes,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new SettingsMutationError(
      "The connection ended before this save was confirmed. Check Audit Logs before trying again.",
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
        : "The server settings could not be saved.";
    const definiteRejection = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(response.status);
    throw new SettingsMutationError(message, definiteRejection ? "failed" : "unknown");
  }

  const parsed = settingsActionResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new SettingsMutationError(
      "The save response could not be verified. Check Audit Logs before trying again.",
      "unknown",
    );
  }
  return parsed.data;
}
