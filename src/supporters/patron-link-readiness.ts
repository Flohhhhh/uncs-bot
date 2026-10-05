import type { AdminSettings } from "../admin/admin.settings";
import type { EnvService } from "../env/env.service";
import { deploymentSecrets } from "./patreon-sync.service";

/** The setting that keeps "Link Patreon" from working (see PatronLinkService.readiness for the staff wording). */
export type PatronLinkSetupProblem = "import" | "clientId" | "clientSecret" | "signIn" | "roles";

/**
 * The first setting that keeps "Link Patreon" from working, or null when it is ready: the Patreon import, the Patreon
 * client ID and secret, the dashboard's Discord sign-in, and the Supporter role. The Link Patreon service and the
 * Supporters page share it, so the page tells staff that a patron can link only when linking really works.
 */
export function patronLinkSetupProblem(
  env: Pick<EnvService, "get">,
  admin: Pick<AdminSettings, "patronLink">,
  importConfigured: boolean,
): PatronLinkSetupProblem | null {
  if (!importConfigured) return "import";
  const clientId = env.get("PATREON_CLIENT_ID");
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(clientId)) return "clientId";
  const secret = env.get("PATREON_CLIENT_SECRET");
  if (
    typeof secret !== "string" ||
    !/^[\x21-\x7e]{16,512}$/.test(secret) ||
    [
      env.get("PATREON_CREATOR_ACCESS_TOKEN"),
      env.get("PATREON_WEBHOOK_SECRET"),
      ...deploymentSecrets(env, { clientSecret: false }),
    ].includes(secret)
  )
    return "clientSecret";
  try {
    admin.patronLink();
  } catch {
    return "signIn";
  }
  if (!env.get("DISCORD_ROLES_ENABLED") || !env.get("DISCORD_SUPPORTER_ROLE_ID")) return "roles";
  return null;
}
