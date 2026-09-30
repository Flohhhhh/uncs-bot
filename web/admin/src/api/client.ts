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
export function configureSession(token: string, onAuthFailure?: (message: string) => void) {
  csrf = token;
  authFailure = onAuthFailure;
  revision++;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Callers can only reach this same-origin API. Never retry a mutation.
  if (!/^[a-z][a-z0-9/-]*(?:\?[^#]*)?$/i.test(path) || path.includes(".."))
    throw new ApiError("Invalid API path.", 400);
  const session = revision;
  const headers = new Headers(options.headers);
  if (options.body != null) {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(`/admin/api/${path}`, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      options.body
        ? "The connection ended before confirmation. Check Action history before repeating this action."
        : "The dashboard could not be reached.",
      0,
    );
  }
  if (session !== revision) throw new ApiError("The staff session changed. Sign in again.", 401);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (session !== revision) throw new ApiError("The staff session changed. Sign in again.", 401);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : "The request could not be completed.";
    if (response.status === 401 || response.status === 403) {
      const callback = authFailure;
      configureSession("");
      callback?.(message);
    }
    throw new ApiError(message, response.status);
  }
  if (data === null)
    throw new ApiError("The response could not be read. Refresh before repeating any action.", response.status);
  return data as T;
}
