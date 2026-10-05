import "server-only";

import { getBackendUrl } from "~/lib/backend-url";

export async function forwardAuth(request: Request, action: "login" | "callback") {
  const headers = new Headers({ "Cache-Control": "no-store" });
  let destination = "/sign-in?reason=unavailable";
  try {
    const backend = getBackendUrl();
    if (!backend)
      return new Response(null, { status: 303, headers: { ...Object.fromEntries(headers), Location: destination } });
    const incoming = new URL(request.url);
    const target = new URL(`${backend.replace(/\/$/, "")}/admin/auth/${action}`);
    if (action === "callback") target.search = incoming.search;
    const upstream = await fetch(target, {
      headers: { Cookie: request.headers.get("cookie") ?? "" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });
    for (const cookie of upstream.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    const location = upstream.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(upstream.status) && location) {
      const redirect = new URL(location, incoming.origin);
      if (redirect.origin === incoming.origin && redirect.pathname === "/admin" && !redirect.search && !redirect.hash) {
        destination = "/admin";
      } else if (
        redirect.origin === "https://discord.com" &&
        !redirect.username &&
        !redirect.password &&
        redirect.pathname === "/oauth2/authorize"
      ) {
        destination = redirect.href;
      }
    } else if (upstream.status === 401) {
      destination = "/sign-in?reason=expired";
    } else if (upstream.status === 403) {
      destination = "/access-denied";
    }
    void upstream.body?.cancel().catch(() => {});
  } catch {
    // OAuth codes, tokens and upstream diagnostics must never reach browser errors or logs.
  }
  headers.set("Location", destination);
  return new Response(null, { status: 303, headers });
}
