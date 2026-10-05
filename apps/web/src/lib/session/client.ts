import { z } from "zod";

export const staffSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "moderator", "viewer"]),
  csrf: z.string().min(1),
  demo: z.boolean().optional(),
});
export type Staff = z.infer<typeof staffSchema>;

export class SessionError extends Error {
  constructor(readonly status: number) {
    super("The staff session could not be verified.");
  }
}

async function sessionRequest(path: string, signal: AbortSignal, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    // Revoke access from the status alone; do not wait for a slow error body.
    void response.body?.cancel().catch(() => {});
    throw new SessionError(response.status);
  }
  return response.json();
}

export async function readSession(signal: AbortSignal) {
  return staffSchema.parse(await sessionRequest("/admin/api/me", signal));
}

export async function endSession(csrf: string, signal: AbortSignal) {
  const result = await sessionRequest("/admin/api/logout", signal, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  });
  z.object({ ok: z.literal(true) }).parse(result);
}
