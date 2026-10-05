"use client";

import Link from "next/link";
import useSWR from "swr";
import {
  ArrowRightIcon,
  ArrowRightLeftIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CrosshairIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  activitySchema,
  auditSchema,
  combatSchema,
  formatActivityTime,
  readAdminApi,
  serverApiPath,
} from "~/components/overview/overview-data";

const refreshOptions = { refreshInterval: 15_000, revalidateOnFocus: true, revalidateOnReconnect: true };

type FeedItem = {
  id: string;
  at: string;
  kind: "players" | "match" | "connection" | "staff" | "combat";
  message: string;
  detail?: string;
  outcome?: string;
};

const actionLabels: Record<string, string> = {
  broadcast: "sent an announcement",
  ban: "banned a player",
  kick: "kicked a player",
  unban: "unbanned a player",
  message: "messaged a player",
  kill: "killed a player",
  team: "changed a player's team",
  "whitelist-add": "added a whitelist entry",
  "whitelist-remove": "removed a whitelist entry",
  "match-end": "ended the match",
  "match-restart": "restarted the match",
  map: "changed the map",
  lighting: "changed the lighting",
  "settings-save": "updated server settings",
  "rotation-save": "updated the map rotation",
  "map-next": "queued the next map",
};

function iconFor(kind: FeedItem["kind"]) {
  switch (kind) {
    case "players":
      return UsersIcon;
    case "match":
      return ArrowRightLeftIcon;
    case "connection":
      return CircleDotIcon;
    case "staff":
      return ShieldCheckIcon;
    case "combat":
      return CrosshairIcon;
  }
}

function outcomeVariant(outcome: string) {
  if (outcome === "failed") return "destructive" as const;
  if (outcome === "applied" || outcome === "accepted") return "secondary" as const;
  return "outline" as const;
}

function weaponName(cause: string | null) {
  if (!cause) return "";
  const name = cause.trim().split(".").at(-1) ?? cause.trim();
  return name.replace(/^(?:ID|Id)_?Item_?/i, "");
}

export function CombinedActivityCard({ serverId }: { serverId: string }) {
  const activityPath = serverApiPath(serverId, "activity");
  const auditPath = serverApiPath(serverId, "audit-notable");
  const combatPath = serverApiPath(serverId, "combat?period=day");
  const activity = useSWR(activityPath, (path) => readAdminApi(path, activitySchema), refreshOptions);
  const audit = useSWR(auditPath, (path) => readAdminApi(path, auditSchema), refreshOptions);
  const combat = useSWR(combatPath, (path) => readAdminApi(path, combatSchema), refreshOptions);

  const items: FeedItem[] = [
    ...(activity.data?.events ?? []).map((event) => ({
      id: `observation:${event.id}`,
      at: event.observedAt,
      kind: event.category,
      message: event.message,
    })),
    ...(audit.data ?? []).map((event) => ({
      id: `action:${event.id}`,
      at: event.createdAt,
      kind: "staff" as const,
      message: `${event.actorName} ${actionLabels[event.action] ?? event.action}${event.target === "server" ? "" : ` · ${event.details.playerName || event.target}`}`,
      detail: event.message,
      outcome: event.state,
    })),
    ...(combat.data?.events ?? []).map((event) => {
      const cause = weaponName(event.cause);
      const details = [
        cause,
        event.headshot ? "Headshot" : "",
        event.distanceMeters == null ? "" : `${Math.round(event.distanceMeters)} m`,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        id: `combat:${event.serverInstanceId}:${event.eventId}`,
        at: event.receivedAt,
        kind: "combat" as const,
        message: event.suicide
          ? `${event.victimName || "Unknown player"} died (suicide)`
          : `${event.killerName || "Unknown killer"} killed ${event.victimName || "unknown player"}`,
        detail: details,
      };
    }),
  ]
    .sort((first, second) => Date.parse(second.at) - Date.parse(first.at))
    .slice(0, 6);

  const reads = [activity, audit, combat];
  const isLoading = reads.some((read) => read.isLoading);
  const failedReads = reads.filter((read) => read.error).length;
  const allFailed = failedReads === reads.length;
  const { mutate: refreshActivity } = activity;
  const { mutate: refreshAudit } = audit;
  const { mutate: refreshCombat } = combat;
  const retry = () => void Promise.all([refreshActivity(), refreshAudit(), refreshCombat()]);

  return (
    <Card className="h-full min-h-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Recent Activity</CardTitle>
        </div>
        <Link
          className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline"
          href={`/admin/activity?server=${encodeURIComponent(serverId)}`}
        >
          All activity <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      </CardHeader>
      <CardContent className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {isLoading && !items.length ? (
          <div aria-label="Loading recent activity" className="space-y-3">
            {[0, 1, 2, 3].map((item) => (
              <Skeleton className="h-10 w-full" key={item} />
            ))}
          </div>
        ) : allFailed ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground" role="alert">
            <p>Recent activity could not be loaded.</p>
            <Button variant="outline" size="xs" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : items.length ? (
          <ol className="divide-y">
            {items.map((item) => {
              const Icon = iconFor(item.kind);
              return (
                <li className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-3 first:pt-0 last:pb-0" key={item.id}>
                  <time
                    className="pt-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                    dateTime={Number.isFinite(Date.parse(item.at)) ? new Date(item.at).toISOString() : undefined}
                    title={Number.isFinite(Date.parse(item.at)) ? new Date(item.at).toLocaleString() : undefined}
                  >
                    {formatActivityTime(item.at)}
                  </time>
                  <div className="min-w-0">
                    <p className="flex items-start gap-2 text-sm leading-5">
                      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 font-medium break-words">{item.message}</span>
                      {item.outcome ? (
                        <Badge variant={outcomeVariant(item.outcome)} className="shrink-0">
                          {item.outcome}
                        </Badge>
                      ) : null}
                    </p>
                    {item.detail ? <p className="mt-1 pl-5 text-xs text-muted-foreground">{item.detail}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <CircleAlertIcon aria-hidden="true" className="size-4" />
            <p>No recent activity yet.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
