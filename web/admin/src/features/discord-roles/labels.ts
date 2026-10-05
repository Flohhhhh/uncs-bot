import type { AttentionItem, PlanEntry, RoleKind } from "./types";

export const roleLabels: Record<RoleKind, string> = { member: "UNC", founder: "Founder", supporter: "Supporter" };
export const roleSettings: Record<RoleKind, string> = {
  member: "DISCORD_MEMBER_ROLE_ID",
  founder: "DISCORD_FOUNDER_ROLE_ID",
  supporter: "DISCORD_SUPPORTER_ROLE_ID",
};
export const configuredKey = {
  member: "memberRole",
  founder: "founderRole",
  supporter: "supporterRole",
} as const satisfies Record<RoleKind, string>;

const triggers: Record<string, string> = {
  startup: "Startup check",
  event: "After a change",
  "member-join": "Member joined",
  admin: "Staff run",
  schedule: "Six-hour safety pass",
};
export const triggerLabel = (trigger: string) => triggers[trigger] ?? "Role check";

const operations: Record<string, string> = { add: "Added", remove: "Removed", note: "Noted only" };
export const operationLabel = (operation: string) => operations[operation] ?? "Recorded";

const providers: Record<string, string> = { patreon: "Patreon", paypal: "PayPal" };
export const providerLabel = (provider?: string) => (provider ? (providers[provider] ?? provider) : "");

/** Why a role would be added, removed or left alone, in the words staff use. Unknown codes are shown as they are. */
const addReasons: Record<RoleKind, string> = {
  member: "Approved UNC member application",
  founder: "Founder record with a linked Discord account",
  supporter: "Supports The UNCs right now",
};
const reasons: Record<string, string> = {
  "retry-unknown-add": "Trying again: Discord never confirmed an earlier add",
  "application-revoked": "Their UNC application was revoked and no other approved one remains",
  "support-lapsed": "Their support has ended",
  "retry-unknown-remove": "Trying again: Discord never confirmed an earlier removal",
  "already-present": "Already has the role. Gramps only notes it and will never remove it",
  "removed-in-discord": "Staff removed this role in Discord, so Gramps won’t add it back",
  "already-absent": "The role was already gone when its reason ended",
  "unknown-add-present": "Confirms an earlier add that Discord didn’t confirm at the time",
  "unknown-remove-absent": "Confirms an earlier removal that Discord didn’t confirm at the time",
  "not-ours": "Has the role, but Gramps didn’t add it, so it stays",
  "not-in-server": "Not in the Discord server, so there’s nothing to change yet",
  "no-basis": "No application or supporter record gives them a role",
};
export function planReason(entry: PlanEntry) {
  if (entry.why === "desired" && entry.roleKind) return addReasons[entry.roleKind];
  return reasons[entry.why] ?? entry.why;
}

export function attentionText(item: AttentionItem) {
  const role = item.roleKind ? roleLabels[item.roleKind] : "";
  switch (item.kind) {
    case "founder_without_discord":
      return "Founder without a linked Discord account. Link their Discord account on the Supporters page so the Founder role can be added.";
    case "not_in_server":
      // Joining queues a check, which may add or remove a role, so this promises only the check.
      return "Not in the Discord server. Gramps checks them again when they join.";
    case "removed_in_discord":
      return `Staff removed the ${role || "community"} role in Discord. Gramps won’t add it back during this membership.`;
    case "failed":
      // Without a role, the server could not read the member, so it never tried a change.
      return role
        ? `A ${role} role change failed. Check the setup above; Gramps checks this person again later.`
        : "Gramps could not read this member from Discord, so it changed none of their roles. It checks them again later.";
    default:
      return "Needs a look.";
  }
}

/** The HTTP status the dashboard's api helper attached to a failure, or null. */
export const errorStatus = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
const serverMessage = (error: unknown) => (error instanceof Error && error.message ? error.message : "");

/** Plain words for a failed preview or role check, using the dashboard's ApiError status. */
export function reconcileError(error: unknown, dryRun: boolean) {
  const message = serverMessage(error);
  switch (errorStatus(error)) {
    case 0:
      return dryRun
        ? "The preview did not finish. A preview never changes roles; try it again."
        : "The connection ended before Gramps confirmed the result, so the role check may still have run. Refresh this page and check Recent role changes before running it again.";
    case 400:
      return `Gramps could not read this request. ${message}`.trim();
    case 403:
      return "Only administrators can manage Discord roles. Sign in again with an administrator account.";
    case 404:
      return "This server version has no Discord roles feature yet. Nothing was changed.";
    case 409:
      return message || "A role check is already running. Try again when it finishes.";
    case 429:
      // Previews and real runs are spaced separately on the server: a preview never holds up a real run.
      return dryRun
        ? "Gramps allows one preview every 5 seconds. Wait a moment, then preview again."
        : "Gramps allows one role check every 30 seconds. Previews don’t count toward this wait. Wait a moment, then try again.";
    case 503:
      if (!message) return "Discord roles are unavailable right now. No role change was sent.";
      return /no role change/i.test(message) ? message : `${message} No role change was sent.`;
    default:
      return (
        message ||
        (dryRun
          ? "The preview could not be completed."
          : "The role check result could not be confirmed. Refresh first.")
      );
  }
}
