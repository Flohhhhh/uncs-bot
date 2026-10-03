import type { EnvService } from "../env/env.service";
import { AUTO_FOUNDER_HOLD_HOURS_DEFAULT } from "./supporter-match.rules";
import { FOUNDER_MINIMUM, policyDays, type FounderPolicy } from "./supporters.types";

type EnvReader = Pick<EnvService, "get">;

/**
 * The provider-neutral founder window. A complete SUPPORTER_FOUNDER_* pair wins; otherwise a
 * complete PATREON_FOUNDER_* pair is used. A half-set pair, or two complete pairs naming different
 * instants, leaves the window unconfigured rather than guessing.
 */
export function founderPolicy(env: EnvReader): FounderPolicy {
  const hold = Number(env.get("SUPPORTER_AUTO_FOUNDER_HOLD_HOURS"));
  const unconfigured: FounderPolicy = {
    amountCents: FOUNDER_MINIMUM.amountCents,
    currency: FOUNDER_MINIMUM.currency,
    startsAt: null,
    endsAt: null,
    configured: false,
    source: null,
    automaticHoldHours: Number.isInteger(hold) && hold >= 0 && hold <= 720 ? hold : AUTO_FOUNDER_HOLD_HOURS_DEFAULT,
  };
  const pairs = [
    {
      source: "SUPPORTER_FOUNDER" as const,
      start: env.get("SUPPORTER_FOUNDER_START_AT"),
      end: env.get("SUPPORTER_FOUNDER_END_AT"),
    },
    {
      source: "PATREON_FOUNDER" as const,
      start: env.get("PATREON_FOUNDER_START_AT"),
      end: env.get("PATREON_FOUNDER_END_AT"),
    },
  ];
  if (pairs.some((pair) => Boolean(pair.start) !== Boolean(pair.end))) return unconfigured;
  const complete = pairs.flatMap(({ source, start, end }) =>
    start && end ? [{ source, start: Date.parse(start), end: Date.parse(end) }] : [],
  );
  if (complete.length === 2 && (complete[0].start !== complete[1].start || complete[0].end !== complete[1].end))
    return unconfigured;
  const chosen = complete[0];
  if (!chosen || !Number.isFinite(chosen.start) || chosen.end - chosen.start !== policyDays * 86_400_000)
    return unconfigured;
  return {
    ...unconfigured,
    startsAt: new Date(chosen.start).toISOString(),
    endsAt: new Date(chosen.end).toISOString(),
    configured: true,
    source: chosen.source,
  };
}

/** The configured Patreon campaign, or null when Patreon is off. PayPal records never need it. */
export function patreonCampaign(env: EnvReader) {
  return env.get("PATREON_ENABLED") && env.get("PATREON_CAMPAIGN_ID") ? env.get("PATREON_CAMPAIGN_ID")! : null;
}
