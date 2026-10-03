export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
let csrf = "";
let revision = 0;
let authFailure: ((message: string) => void) | undefined;
let pendingReads = 0;
export const READ_TIMEOUT_MS = 45_000;
export const MUTATION_TIMEOUT_MS = 60_000;
export function isReadPending() {
  return pendingReads > 0;
}
export function configureSession(token: string, onAuthFailure?: (message: string) => void) {
  csrf = token;
  authFailure = onAuthFailure;
  revision++;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Callers can only reach this same-origin API. Never retry a mutation.
  // Only the route can traverse; ".." in a query value, such as a searched name, is ordinary text.
  // Map IDs may hold "_", "." or an encoded "/", so the route allows them, but never "%2e": browsers
  // turn an encoded ".." segment back into a real one.
  const route = path.split("?", 1)[0];
  if (!/^[a-z][a-z0-9/._~%-]*(?:\?[^#]*)?$/i.test(path) || route.includes("..") || /%2e/i.test(route))
    throw new ApiError("Invalid API path.", 400);
  if (options.signal?.aborted) throw options.signal.reason;
  const mutation = !["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase());
  const session = revision;
  const headers = new Headers(options.headers);
  if (options.body != null) {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", csrf);
  }
  const controller = new AbortController();
  let rejectCancellation!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (reason: unknown) => {
    controller.abort(reason);
    rejectCancellation(reason);
  };
  const callerAbort = () => cancel(options.signal?.reason);
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const timeout = setTimeout(
    () =>
      cancel(
        new ApiError(
          mutation
            ? "The request timed out before confirmation. Check Action history before repeating this action."
            : "The dashboard request timed out. Try refreshing this page.",
          0,
        ),
      ),
    mutation ? MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS,
  );
  const checkSession = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (session !== revision)
      throw new ApiError(
        mutation
          ? "The staff session changed before the result was confirmed. Check Action history before repeating this action."
          : "The staff session changed. Sign in again.",
        mutation ? 0 : 401,
      );
  };
  if (!mutation) pendingReads++;
  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetch(`/admin/api/${path}`, {
          ...options,
          signal: controller.signal,
          headers,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        }),
        cancelled,
      ]);
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new ApiError(
        mutation
          ? "The connection ended before confirmation. Check Action history before repeating this action."
          : "The dashboard could not be reached.",
        0,
      );
    }
    checkSession();
    // Denial headers are enough to revoke local access. Never wait for a slow
    // or malformed error body while private records remain mounted.
    if (response.status === 401 || response.status === 403) {
      const message = "Your staff session or access could not be verified. Sign in again.";
      const callback = authFailure;
      configureSession("");
      callback?.(message);
      void response.body?.cancel().catch(() => {});
      throw new ApiError(message, response.status);
    }
    let data: unknown;
    try {
      data = await Promise.race([response.json(), cancelled]);
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      data = null;
    }
    checkSession();
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "message" in data && typeof data.message === "string"
          ? data.message
          : "The request could not be completed.";
      throw new ApiError(message, response.status);
    }
    if (data === null)
      throw new ApiError("The response could not be read. Refresh before repeating any action.", response.status);
    return data as T;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", callerAbort);
    if (!mutation) pendingReads--;
  }
}
