import { expect, it, vi } from "vitest";

import { endSession } from "~/lib/session/client";

it("forwards the session CSRF token on one same-origin logout request", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);

  await endSession("csrf-token", new AbortController().signal);

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "/admin/api/logout",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": "csrf-token" },
    }),
  );
});

it("does not treat an unconfirmed logout as success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false })));

  await expect(endSession("csrf-token", new AbortController().signal)).rejects.toThrow();
});
