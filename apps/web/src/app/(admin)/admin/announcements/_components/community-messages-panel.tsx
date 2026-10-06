"use client";

import Link from "next/link";
import useSWR from "swr";
import { ChevronRightIcon } from "lucide-react";

import { readAdminApi, serverApiPath } from "~/components/overview/overview-data";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";

import {
  communityMessagesSchema,
  displayDate,
  formatSeconds,
  liveRefreshOptions,
  plural,
  type CommunityMessages,
} from "./announcement-data";

function StateBadge({ on, label }: { on: boolean; label?: string }) {
  return (
    <Badge
      variant="outline"
      className={
        label
          ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
          : on
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
            : "text-muted-foreground"
      }
    >
      {label ?? (on ? "On" : "Off")}
    </Badge>
  );
}

function DetailRow({
  title,
  badge,
  summary,
  children,
}: {
  title: string;
  badge: React.ReactNode;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-1 items-center gap-2 py-3 marker:hidden sm:grid-cols-[minmax(0,1fr)_minmax(14rem,1fr)] sm:gap-4 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="truncate font-medium">{title}</span>
            {badge}
          </span>
          <span className="pl-6 text-sm text-muted-foreground sm:pl-0 sm:text-right">{summary}</span>
        </summary>
        <div className="space-y-3 pb-4 pl-6 text-sm">{children}</div>
      </details>
    </li>
  );
}

function VariantMessages({ label, variants }: { label?: string; variants: string[][] }) {
  const suffix = label ? ` · ${label}` : "";
  if (variants.length === 1) {
    return (
      <ol className="list-inside list-decimal space-y-1" aria-label={`Welcome messages${suffix}`}>
        {variants[0].map((message, index) => (
          <li key={`${index}:${message}`}>{message}</li>
        ))}
      </ol>
    );
  }

  return (
    <>
      <p className="text-muted-foreground">Each join gets a random variant, never that player’s previous one.</p>
      <ol className="list-inside list-decimal space-y-3" aria-label={`Welcome variants${suffix}`}>
        {variants.map((messages, index) => (
          <li key={index}>
            {messages.map((message, part) => (
              <span key={part} className="block pl-5 leading-relaxed">
                {message}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </>
  );
}

function WhitelistCheck({ welcome }: { welcome: CommunityMessages["welcome"] }) {
  const whitelist = welcome.whitelist;
  if (!whitelist) return null;
  const lastLoaded = whitelist.lastLoadedAt ? Date.parse(whitelist.lastLoadedAt) : Number.NaN;
  const lastFailed = whitelist.lastFailedAt ? Date.parse(whitelist.lastFailedAt) : Number.NaN;
  const failing = Number.isFinite(lastFailed) && (!Number.isFinite(lastLoaded) || lastFailed > lastLoaded);

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <p>
        Whitelist check:{" "}
        <strong>{failing ? "Last read failed" : Number.isFinite(lastLoaded) ? "Working" : "Not read yet"}</strong>
      </p>
      {failing && Number.isFinite(lastFailed) ? (
        <p className="mt-1 text-muted-foreground">Failed {displayDate(whitelist.lastFailedAt)}</p>
      ) : null}
      {Number.isFinite(lastLoaded) ? (
        <p className="mt-1 text-muted-foreground">Last read {displayDate(whitelist.lastLoadedAt)}</p>
      ) : (
        <p className="mt-1 text-muted-foreground">
          {welcome.enabled ? "Reads on the next join." : "Not read while the welcome message is off."}
        </p>
      )}
      <p className="mt-1 text-muted-foreground">Reused for up to {formatSeconds(whitelist.cacheSeconds)}.</p>
      <p className="mt-2 text-muted-foreground">
        This checks the game’s running whitelist (reserved slots), not saved configuration. Changes made through Gramps
        refresh it sooner.
      </p>
      {failing ? (
        <p className="mt-2 text-muted-foreground">
          After a failed read, joiners get the standard welcome for a minute.
        </p>
      ) : null}
    </div>
  );
}

function WelcomeDetails({ welcome }: { welcome: CommunityMessages["welcome"] }) {
  const variants = welcome.variants?.length ? welcome.variants : [welcome.messages];
  const whitelisted = welcome.whitelistedVariants?.length ? welcome.whitelistedVariants : null;
  const sequences = [...variants, ...(whitelisted ?? [])];
  const spaced = sequences.some((messages) => messages.length > 1);
  const count =
    variants.length === 1 && !whitelisted
      ? plural(variants[0].length, "message")
      : `${plural(variants.length, "variant")}${whitelisted ? `, ${whitelisted.length} for whitelisted players` : ""}`;

  return (
    <DetailRow
      title="Welcome"
      badge={<StateBadge on={welcome.enabled} />}
      summary={`${count} · ${formatSeconds(welcome.delaySeconds)} delay`}
    >
      <p className="text-muted-foreground">
        Sent {formatSeconds(welcome.delaySeconds)} after an observed join
        {spaced ? `, at least ${formatSeconds(welcome.spacingSeconds)} apart` : ""}.
      </p>
      {whitelisted ? (
        <>
          <section className="space-y-2 border-t pt-3">
            <h3 className="font-medium">Everyone else</h3>
            <VariantMessages label="for everyone else" variants={variants} />
          </section>
          <section className="space-y-2 border-t pt-3">
            <h3 className="font-medium">Players already on the whitelist</h3>
            <WhitelistCheck welcome={welcome} />
            <VariantMessages label="for players already on the whitelist" variants={whitelisted} />
          </section>
        </>
      ) : (
        <VariantMessages variants={variants} />
      )}
    </DetailRow>
  );
}

function RoundDetails({ round }: { round: CommunityMessages["round"] }) {
  const messages = round.messages?.length ? round.messages : [round.message];
  const summary =
    messages.length > 1
      ? `${plural(messages.length, "message")} · after each observed round change`
      : "After each observed round change";

  return (
    <DetailRow title="Round notice" badge={<StateBadge on={round.enabled} />} summary={summary}>
      {messages.length > 1 ? (
        <>
          <p className="text-muted-foreground">Each round gets a random message, never the previous round’s.</p>
          <ol className="list-inside list-decimal space-y-1" aria-label="Round messages">
            {messages.map((message, index) => (
              <li key={`${index}:${message}`}>{message}</li>
            ))}
          </ol>
        </>
      ) : (
        <p>{messages[0]}</p>
      )}
      <p className="text-muted-foreground">A missed round change may skip a notice.</p>
    </DetailRow>
  );
}

function ObservationDetails({ data, serverId }: { data: CommunityMessages; serverId: string }) {
  const entries = [
    ["Last server observation", data.lastObservedAt],
    ["Last message acknowledged", data.lastMessageAcknowledgedAt],
    ["Last Discord card update", data.lastStatusCardUpdatedAt],
  ] as const;

  return (
    <details className="group border-t pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 font-medium marker:hidden [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        Activity &amp; setup
      </summary>
      <div className="space-y-4 pb-2 pl-6 text-sm">
        <dl className="grid gap-3 sm:grid-cols-3">
          {entries.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-medium">{displayDate(value)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">
          Times cover this Gramps process. An acknowledgment means the game accepted the message; it does not prove a
          player saw it. Change message settings in the Gramps deployment.
        </p>
        <Link
          className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
          href={`/admin/audit-logs?server=${encodeURIComponent(serverId)}&view=actions`}
        >
          View message receipts <span aria-hidden="true">→</span>
        </Link>
      </div>
    </details>
  );
}

function MessageTable({ data, serverId }: { data: CommunityMessages; serverId: string }) {
  const discordLabel = !data.discordStatus.enabled
    ? undefined
    : !data.discordStatus.configured
      ? "Needs channel and message"
      : data.discordStatus.problem
        ? "Not updating"
        : undefined;

  return (
    <>
      {data.enabled &&
      !data.workerStarted &&
      (data.welcome.enabled || data.round.enabled || (data.discordStatus.enabled && data.discordStatus.configured)) ? (
        <Alert className="mb-4 border-amber-500/30 bg-amber-500/5">
          <AlertTitle>Message worker has not started</AlertTitle>
          <AlertDescription>
            Check the Gramps deployment. Automatic messages are not running on this server.
          </AlertDescription>
        </Alert>
      ) : null}

      <ul className="divide-y" aria-label="Automatic messages">
        <WelcomeDetails welcome={data.welcome} />
        <RoundDetails round={data.round} />
        <li className="py-3">
          <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,1fr)] sm:gap-4">
            <span className="flex min-w-0 items-center gap-2 pl-6">
              <span className="truncate font-medium">Discord card</span>
              <StateBadge on={data.discordStatus.enabled} label={discordLabel} />
            </span>
            <span className="pl-6 text-sm text-muted-foreground sm:pl-0 sm:text-right">Server status in Discord</span>
          </div>
          {data.discordStatus.enabled && data.discordStatus.configured && data.discordStatus.problem ? (
            <p className="mt-2 pl-6 text-sm text-amber-500">{data.discordStatus.problem}</p>
          ) : null}
        </li>
      </ul>
      <ObservationDetails data={data} serverId={serverId} />
    </>
  );
}

export function CommunityMessagesPanel({ serverId }: { serverId: string }) {
  const path = serverApiPath(serverId, "community-messages");
  const status = useSWR(path, (url) => readAdminApi(url, communityMessagesSchema), liveRefreshOptions);
  const data = status.data;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-4 pb-4 sm:px-6">
        <CardTitle>Automatic messages</CardTitle>
        <CardDescription>
          {data
            ? data.enabled
              ? "Set in the Gramps deployment."
              : "Turned off for this deployment."
            : "Message settings and recent observations for this server."}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 sm:p-6" aria-busy={status.isLoading || status.isValidating}>
        {status.error && data ? (
          <Alert className="mb-4">
            <AlertTitle>Message status refresh failed</AlertTitle>
            <AlertDescription>
              The last loaded status remains visible. Retry when the server connection is back.
            </AlertDescription>
          </Alert>
        ) : null}
        {status.error && !data ? (
          <Alert variant="destructive">
            <AlertTitle>Message status could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>No activation state has been assumed.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void status.mutate()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : data ? (
          <MessageTable data={data} serverId={serverId} />
        ) : (
          <p className="py-2 text-sm text-muted-foreground" role="status">
            {status.isLoading ? "Loading automatic message status…" : "Waiting for automatic message status…"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
