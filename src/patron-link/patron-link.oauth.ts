import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PATREON_USER_AGENT, readBounded } from "../supporters/patreon.client";

/** The routes on ADMIN_ORIGIN. Both callbacks are registered as redirect URIs with Discord and Patreon. */
export const PATRON_LINK_PATHS = {
  start: "/supporters/link/start",
  discord: "/supporters/link/discord/callback",
  patreon: "/supporters/link/patreon/callback",
  done: "/supporters/link/done",
} as const;
export const PATRON_LINK_TIMEOUT_MS = 10_000;
export const PATRON_LINK_MAX_BYTES = 65_536;
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_API = "https://discord.com/api/v10";
// Docs: docs.patreon.com "OAuth" (authorize, token) and "GET /api/oauth2/v2/identity". With only the identity scope,
// identity lists the user's membership of the client creator's own campaign, and nothing else.
const PATREON_AUTHORIZE = "https://www.patreon.com/oauth2/authorize";
const PATREON_TOKEN = "https://www.patreon.com/api/oauth2/token";
const PATREON_IDENTITY = "https://www.patreon.com/api/oauth2/v2/identity";

/** The settings one sign-in needs. Secrets stay in here and are only ever sent to the provider they belong to. */
export type PatronLinkClients = {
  origin: string;
  discordClientId: string;
  discordClientSecret: string;
  patreonClientId: string;
  patreonClientSecret: string;
};

/**
 * `rejected`: the provider refused the code (400 or 401), so the sign-in expired. `unavailable`: anything else. The
 * message is fixed and never holds a response, code or token.
 */
export class PatronLinkCallError extends Error {
  constructor(readonly kind: "rejected" | "unavailable") {
    super(kind === "rejected" ? "The provider refused the sign-in code." : "The provider did not answer.");
    this.name = "PatronLinkCallError";
  }
}

// Only the access token is read from a token answer. It is used once, here, and never stored or logged.
const tokenSchema = z.object({ access_token: z.string().min(1).max(4096) });
const discordUserSchema = z.object({ id: z.string().regex(/^\d{17,20}$/), bot: z.boolean().optional() });
const patreonId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const identitySchema = z.object({
  data: z.object({
    id: patreonId,
    type: z.literal("user"),
    relationships: z
      .object({
        memberships: z.object({ data: z.array(z.object({ id: patreonId, type: z.literal("member") })).max(100) }),
      })
      .nullish(),
  }),
});

/** Discord's and Patreon's sign-in calls for "Link Patreon". Every call is bounded, redirect-free and read with zod. */
@Injectable()
export class PatronLinkOAuth {
  /** Discord's Authorize page. With `promptNone`, someone who signed in to Gramps before skips the Authorize screen. */
  discordAuthorizeUrl(clients: PatronLinkClients, state: string, promptNone: boolean) {
    const query = new URLSearchParams({
      client_id: clients.discordClientId,
      redirect_uri: `${clients.origin}${PATRON_LINK_PATHS.discord}`,
      response_type: "code",
      scope: "identify",
      state,
    });
    if (promptNone) query.set("prompt", "none");
    return `${DISCORD_AUTHORIZE}?${query}`;
  }

  /** Patreon's Authorize page, asking for the identity scope only. */
  patreonAuthorizeUrl(clients: PatronLinkClients, state: string) {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clients.patreonClientId,
      redirect_uri: `${clients.origin}${PATRON_LINK_PATHS.patreon}`,
      scope: "identity",
      state,
    });
    return `${PATREON_AUTHORIZE}?${query}`;
  }

  /** The Discord account that signed in. */
  async discordUser(clients: PatronLinkClients, code: string) {
    const token = await this.call(
      `${DISCORD_API}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clients.discordClientId,
          client_secret: clients.discordClientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: `${clients.origin}${PATRON_LINK_PATHS.discord}`,
        }).toString(),
      },
      tokenSchema,
      true,
    );
    const user = await this.call(
      `${DISCORD_API}/users/@me`,
      { headers: { Authorization: `Bearer ${token.access_token}` } },
      discordUserSchema,
      false,
    );
    return { id: user.id, bot: user.bot === true };
  }

  /**
   * The Patreon user who signed in and their memberships of the creator's campaign. No fields are asked for, so
   * Patreon sends no name or email.
   */
  async patreonIdentity(clients: PatronLinkClients, code: string) {
    const token = await this.call(PATREON_TOKEN, this.patreonTokenRequest(clients, code), tokenSchema, true);
    const identity = await this.call(
      `${PATREON_IDENTITY}?${new URLSearchParams({ include: "memberships" })}`,
      { headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": PATREON_USER_AGENT } },
      identitySchema,
      false,
    );
    return {
      userId: identity.data.id,
      memberships: [...new Set((identity.data.relationships?.memberships.data ?? []).map((member) => member.id))],
    };
  }

  /**
   * Spends a Patreon code that arrived without its sign-in (a forwarded or replayed link) at Patreon too, on top of
   * Gramps refusing it for good (PatronLinkState.refuseCode), so it is useless even after a restart. Best effort, within
   * a budget. The answer is never read. Never throws.
   */
  async burnPatreonCode(clients: PatronLinkClients, code: string) {
    try {
      const response = await fetch(PATREON_TOKEN, this.request(this.patreonTokenRequest(clients, code)));
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Nothing to report: the code was refused, already used or never reached Patreon.
    }
  }

  private patreonTokenRequest(clients: PatronLinkClients, code: string): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": PATREON_USER_AGENT },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: clients.patreonClientId,
        client_secret: clients.patreonClientSecret,
        redirect_uri: `${clients.origin}${PATRON_LINK_PATHS.patreon}`,
      }).toString(),
    };
  }

  private request(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
      redirect: "error",
      signal: AbortSignal.timeout(PATRON_LINK_TIMEOUT_MS),
    };
  }

  /** One bounded call. `rejectable`: a 400 or 401 means the code was refused. */
  private async call<T extends z.ZodType>(url: string, init: RequestInit, schema: T, rejectable: boolean) {
    let response: Response;
    try {
      response = await fetch(url, this.request(init));
    } catch {
      throw new PatronLinkCallError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PatronLinkCallError(rejectable && [400, 401].includes(response.status) ? "rejected" : "unavailable");
    }
    try {
      const parsed = schema.safeParse(JSON.parse(await readBounded(response, PATRON_LINK_MAX_BYTES)));
      if (parsed.success) return parsed.data as z.infer<T>;
    } catch {
      // Oversized or not JSON: reported below.
    }
    throw new PatronLinkCallError("unavailable");
  }
}
