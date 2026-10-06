import type { z } from "zod";

export class ServiceCallError extends Error {
  constructor(
    readonly outcome: "rejected" | "unknown",
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(
      outcome === "unknown"
        ? "The operation could not be confirmed. Do not retry automatically."
        : "The service rejected the request.",
    );
  }
}

/** One HTTP attempt. No retries, redirects, cookie authentication, or upstream diagnostic logging. */
export class ServiceClient {
  private readonly origin: URL;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly timeoutMs = 15000,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origin = new URL(origin);
    if (
      !["http:", "https:"].includes(this.origin.protocol) ||
      this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== "/" ||
      this.origin.search ||
      this.origin.hash
    )
      throw new Error("Use a service origin without credentials or a path.");
    if (token.length < 32 || /\s/.test(token))
      throw new Error("Use a dedicated service credential of at least 32 characters.");
  }
  async request<T>(path: `/internal/v1/${string}`, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origin), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ServiceCallError("unknown");
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ServiceCallError("unknown", response.status);
    }
    if (!response.ok)
      throw new ServiceCallError(
        response.status >= 400 && response.status < 500 ? "rejected" : "unknown",
        response.status,
        value,
      );
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ServiceCallError("unknown", response.status);
    return parsed.data;
  }
}

/** Bounded process-local duplicate suppression; intentionally provides no durability across restarts. */
export class OperationReceipts {
  private readonly entries = new Map<string, { fingerprint: string; until: number; result: Promise<unknown> }>();
  run<T>(id: string, body: unknown, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.until < now) this.entries.delete(key);
    const fingerprint = JSON.stringify(body);
    const previous = this.entries.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new ServiceCallError("rejected", 409));
      return previous.result as Promise<T>;
    }
    if (this.entries.size >= 10000) return Promise.reject(new ServiceCallError("rejected", 503));
    const result = Promise.resolve().then(operation);
    this.entries.set(id, { fingerprint, until: now + 30 * 60000, result });
    return result;
  }
}
