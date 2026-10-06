"use client";

import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";

import {
  attentionText,
  configuredKey,
  displayDate,
  operationLabel,
  plural,
  providerLabel,
  roleKinds,
  roleLabels,
  roleSettings,
  timeAhead,
  timeAgo,
  triggerLabel,
  type AttentionItem,
  type DiscordRolesStatus,
  type PassSummary,
  type RoleKind,
} from "./discord-roles-data";

function CopyId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${label} ${value}`}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ""}
      </span>
    </span>
  );
}

function Time({ value, relative = false }: { value: string; relative?: boolean }) {
  const valid = Number.isFinite(Date.parse(value));
  if (!valid) return <>Not recorded</>;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {relative ? timeAgo(value) : displayDate(value)}
    </time>
  );
}

function statusDescription(data: DiscordRolesStatus) {
  const checked = data.bot.manageRoles !== null;
  if (data.enabled) {
    if (data.ready) {
      return "Gramps keeps the configured roles in step with applications and supporter records, and checks everyone every six hours.";
    }
    return checked
      ? "Switched on, but a role fails its setup checks below. Gramps skips that role until it is fixed."
      : "Switched on, but Gramps can’t read the Discord server yet, so it changes no roles until it can. See the setup checks below.";
  }
  return data.ready
    ? "Switched off in Railway (DISCORD_ROLES_ENABLED=false). Every configured role passes its checks: preview the changes, then set DISCORD_ROLES_ENABLED=true in Railway and restart Gramps. Its first start adds the roles people have already earned."
    : "Switched off in Railway (DISCORD_ROLES_ENABLED=false). Gramps changes no roles. You can still check the setup and preview what would change.";
}

function StateBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "good" | "warning" | "bad" | "neutral";
}) {
  const colors = {
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    bad: "border-destructive/40 bg-destructive/10 text-destructive",
    neutral: "text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={colors[tone]}>
      {children}
    </Badge>
  );
}

function DiscordRolesStatusHeader({ data }: { data: DiscordRolesStatus }) {
  const readyTone = data.ready && data.discordReady;
  const featureState = data.enabled ? "On" : data.ready ? "Ready to switch on" : "Off";
  const retryAt = data.nextRetryAt && Number.isFinite(Date.parse(data.nextRetryAt)) ? data.nextRetryAt : null;
  return (
    <section aria-label="Automatic Discord role status" className="rounded-lg border bg-card px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-live="off">
        <span className="font-medium">
          Automatic Discord roles: <strong>{featureState}</strong>
        </span>
        <span className="text-muted-foreground">
          {data.discordReady ? "Discord connected" : "Discord not connected"}
        </span>
        {data.running ? <span className="text-muted-foreground">A role check is running now</span> : null}
        {data.queued > 0 ? (
          <span className="text-muted-foreground">{plural(data.queued, "person", "people")} waiting for a check</span>
        ) : null}
        {data.fullPassQueued ? <span className="text-muted-foreground">A check of everyone is queued</span> : null}
        {retryAt ? <span className="text-muted-foreground">Next retry {timeAhead(retryAt)}</span> : null}
        <StateBadge tone={readyTone ? "good" : "warning"}>{readyTone ? "Setup ready" : "Needs attention"}</StateBadge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{statusDescription(data)}</p>
    </section>
  );
}

function CheckRow({ title, badge, children }: { title: ReactNode; badge: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid gap-2 border-b px-4 py-4 last:border-b-0 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{title}</strong>
        {badge}
      </div>
      {children}
    </li>
  );
}

function roleFacts(kind: RoleKind, data: DiscordRolesStatus) {
  const role = data.roles[kind];
  const configured = data.configured[configuredKey[kind]];
  const optionalOff = kind === "supporter" && !configured;
  const checked = data.bot.manageRoles !== null;
  const badge = role.assignable ? (
    <StateBadge tone="good">Ready</StateBadge>
  ) : optionalOff ? (
    <StateBadge>Optional · not set up</StateBadge>
  ) : !checked ? (
    <StateBadge tone="warning">Not checked</StateBadge>
  ) : (
    <StateBadge tone="bad">Needs a fix</StateBadge>
  );
  const status = role.name
    ? `Discord role “${role.name}”`
    : !configured
      ? "No role ID set"
      : checked
        ? "No Discord role found"
        : "Not read from Discord yet";
  const fact = (value: boolean) => (checked ? (value ? "Yes" : "No") : "Not checked");

  return (
    <CheckRow title={`${roleLabels[kind]} role${kind === "supporter" ? " (optional)" : ""}`} badge={badge}>
      <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <span>{status}</span>
        {role.id ? (
          <>
            <span aria-hidden="true">·</span>
            <CopyId value={role.id} label={`${roleLabels[kind]} role ID`} />
          </>
        ) : null}
      </p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Fact label="Configured" value={configured ? "Yes" : "No"} />
        <Fact label="Exists in Discord" value={fact(role.exists)} />
        {role.position !== null ? <Fact label="Position" value={String(role.position)} /> : null}
        <Fact label="Gramps can assign it" value={fact(role.assignable)} />
      </dl>
      {optionalOff ? (
        <p className="text-sm text-muted-foreground">
          Optional. Without {roleSettings.supporter}, Gramps skips the Supporter role entirely. It is a Discord role
          only and changes nothing in game.
        </p>
      ) : null}
      {checked && role.problem ? (
        <p className={`text-sm leading-relaxed ${optionalOff ? "text-muted-foreground" : "text-amber-400"}`}>
          <strong>{optionalOff ? "To add it:" : "Fix:"}</strong> {role.problem}
        </p>
      ) : null}
      {!role.exists && role.candidates ? (
        <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          {role.candidates.length ? (
            <>
              <p>
                Roles named “{roleLabels[kind]}” in this server. Copy the right one into {roleSettings[kind]}:
              </p>
              <ul className="grid gap-2">
                {role.candidates.map((candidate) => (
                  <li key={candidate.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{candidate.name}</span>
                    <CopyId value={candidate.id} label={`${roleLabels[kind]} role ID`} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No role named “{roleLabels[kind]}” was found in this server.</p>
          )}
        </div>
      ) : null}
    </CheckRow>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function SetupChecks({ data }: { data: DiscordRolesStatus }) {
  const manage = data.bot.manageRoles;
  const unread =
    data.roles.member.problem ??
    (data.discordReady ? "The Discord server could not be read." : "Discord is not connected yet.");
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-4 pb-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle>Setup checks</CardTitle>
            <CardDescription>Read from Discord with each refresh. Reading the setup changes nothing.</CardDescription>
          </div>
          <StateBadge tone={data.ready ? "good" : "warning"}>{data.ready ? "Ready" : "Needs a fix"}</StateBadge>
        </div>
      </CardHeader>
      <ul aria-label="Setup checks" className="divide-y">
        <CheckRow
          title="Community server"
          badge={
            data.configured.guild ? (
              <StateBadge tone="good">Set</StateBadge>
            ) : (
              <StateBadge tone="bad">Not set</StateBadge>
            )
          }
        >
          {!data.configured.guild ? (
            <p className="text-sm text-amber-400">
              <strong>Fix:</strong> Set ADMIN_GUILD_ID to the community Discord server.
            </p>
          ) : null}
        </CheckRow>
        <CheckRow
          title="Bot can manage roles"
          badge={
            manage === null ? (
              <StateBadge tone="warning">Not checked</StateBadge>
            ) : manage ? (
              <StateBadge tone="good">Yes</StateBadge>
            ) : (
              <StateBadge tone="bad">No</StateBadge>
            )
          }
        >
          {manage === false ? (
            <p className="text-sm text-amber-400">
              <strong>Fix:</strong> Give the bot’s role the Manage Roles permission in Server Settings, Roles.
            </p>
          ) : null}
          {manage === null ? (
            <p className="text-sm text-amber-400">
              <strong>Not checked:</strong> {unread}
            </p>
          ) : null}
          {data.bot.highestRolePosition !== null ? (
            <p className="text-sm text-muted-foreground">
              The bot’s highest role is at position {data.bot.highestRolePosition}. Each role below must have a lower
              position.
            </p>
          ) : null}
        </CheckRow>
        {roleKinds.map((kind) => (
          <RoleCheckRow key={kind} data={data} kind={kind} />
        ))}
      </ul>
      <p className="px-4 py-3 text-sm text-muted-foreground sm:px-5">
        {data.ready
          ? "Every configured role passes its checks."
          : "Fix the items marked “Needs a fix” before switching automatic roles on."}
      </p>
    </Card>
  );
}

function RoleCheckRow({ data, kind }: { data: DiscordRolesStatus; kind: RoleKind }) {
  return roleFacts(kind, data);
}

function SummaryCounts({ data }: { data: DiscordRolesStatus }) {
  const counts = [
    ["UNC eligible", data.summary.memberEligible, "People with an approved UNC member application"],
    ["Founders", data.summary.founders, "Founder records"],
    ["Founders without Discord", data.summary.foundersWithoutDiscord, "Can’t get the Founder role yet"],
    [
      "Supporters now",
      data.summary.supporterEligible,
      data.summary.supporterEligible === null ? "Supporter role not set up" : "Support right now, with Discord linked",
    ],
  ] as const;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardContent className="p-0">
        <dl aria-label="Role counts" className="grid grid-cols-2 md:grid-cols-4">
          {counts.map(([label, value, detail], index) => (
            <div key={label} className={`min-w-0 px-4 py-4 sm:px-5 ${index ? "border-l" : ""}`}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-2 text-3xl font-semibold tabular-nums">
                {value === null ? "—" : value.toLocaleString()}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function PassCounts({ pass }: { pass: PassSummary }) {
  const counts: [string, number][] = [
    ["Added", pass.added],
    ["Removed", pass.removed],
    ["Noted", pass.noted],
    ["Failed", pass.failed],
    ["Blocked", pass.blocked],
    ["Deferred", pass.deferred],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {counts.map(([label, value]) => (
        <div key={label} className="rounded-md bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 font-semibold tabular-nums">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function LastPass({ title, pass }: { title: string; pass: PassSummary | null }) {
  const at = pass ? pass.finishedAt || pass.startedAt : null;
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="font-medium">{title}</h3>
      {pass && at && Number.isFinite(Date.parse(at)) ? (
        <>
          <p className="mt-1 mb-3 text-sm text-muted-foreground">
            {triggerLabel(pass.trigger)} · finished <Time value={at} relative /> ·{" "}
            {plural(pass.users, "person", "people")} checked
          </p>
          {pass.error ? <p className="mb-3 text-sm text-amber-400">{pass.error}</p> : null}
          <PassCounts pass={pass} />
          {pass.deferred > 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Deferred people are checked again in about a minute (50 changes per check).
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">No check has run since Gramps last started.</p>
      )}
    </section>
  );
}

function LastPasses({ data }: { data: DiscordRolesStatus }) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-4 py-0 sm:px-5">
        <CardTitle>Last role checks</CardTitle>
        <CardDescription>Kept in memory since Gramps last started.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 px-4 sm:grid-cols-2 sm:px-5">
        <LastPass title="Last check" pass={data.lastPass} />
        <LastPass title="Last full check" pass={data.lastFullPass} />
      </CardContent>
    </Card>
  );
}

function AttentionEntry({ item }: { item: AttentionItem }) {
  const founder = item.kind === "founder_without_discord";
  return (
    <li className="grid gap-1 border-b px-4 py-3 text-sm last:border-b-0 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        {founder ? (
          <strong>{item.displayName || "Unnamed founder"}</strong>
        ) : item.discordUserId ? (
          <CopyId value={item.discordUserId} label="Discord user ID" />
        ) : (
          <strong>Unknown member</strong>
        )}
        {founder && item.provider ? <Badge variant="secondary">{providerLabel(item.provider)}</Badge> : null}
        {item.roleKind ? <Badge variant="outline">{roleLabels[item.roleKind]}</Badge> : null}
      </div>
      <p className="leading-relaxed">{attentionText(item)}</p>
      {item.at && Number.isFinite(Date.parse(item.at)) ? (
        <small className="text-xs text-muted-foreground">
          {founder ? "Founder since" : "Noticed"} <Time value={item.at} />
        </small>
      ) : null}
    </li>
  );
}

function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex items-center justify-between border-b px-4 py-4 pb-4 sm:px-5">
        <div className="grid gap-1.5">
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>{items.length ? plural(items.length, "item") : "Nothing to follow up"}</CardDescription>
        </div>
        {items.length ? <StateBadge tone="warning">{items.length.toLocaleString()}</StateBadge> : null}
      </CardHeader>
      {items.length ? (
        <ul aria-label="Needs attention" className="divide-y">
          {items.map((item, index) => (
            <AttentionEntry key={`${item.kind}:${item.discordUserId ?? item.supporterId ?? ""}:${index}`} item={item} />
          ))}
        </ul>
      ) : (
        <CardContent className="p-4 sm:p-5">
          <p className="font-medium">Nothing needs attention</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Founders without Discord and failed changes would show here.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function ResultBadge({ operation, state }: { operation: string; state: string }) {
  if (operation === "note") return <Badge variant="secondary">Noted</Badge>;
  if (state === "applied") return <StateBadge tone="good">{state}</StateBadge>;
  if (state === "failed") return <StateBadge tone="bad">{state}</StateBadge>;
  if (state === "unknown" || state === "started") return <StateBadge tone="warning">{state}</StateBadge>;
  return <Badge variant="outline">{state}</Badge>;
}

function RecentLedger({ rows }: { rows: DiscordRolesStatus["recent"] }) {
  const latest = rows.slice(0, 25);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-4 pb-4 sm:px-5">
        <CardTitle>Recent role changes</CardTitle>
        <CardDescription>The latest 25 rows from the role ledger, newest first.</CardDescription>
      </CardHeader>
      {latest.length ? (
        <Table aria-label="Recent role changes" className="min-w-[48rem]">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Discord user</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {latest.map((row, index) => (
              <TableRow key={row.id} className={index % 2 === 1 ? "bg-muted/30" : undefined}>
                <TableCell>
                  <span title={new Date(row.createdAt).toLocaleString()}>
                    <Time value={row.createdAt} />
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{triggerLabel(row.trigger)}</span>
                </TableCell>
                <TableCell>
                  <CopyId value={row.discordUserId} label="Discord user ID" />
                </TableCell>
                <TableCell>{roleLabels[row.roleKind]}</TableCell>
                <TableCell>{operationLabel(row.operation)}</TableCell>
                <TableCell className="whitespace-normal">
                  <ResultBadge operation={row.operation} state={row.state} />
                  <p className="mt-1 max-w-md min-w-56 text-sm text-muted-foreground">{row.message}</p>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <CardContent className="p-4 sm:p-5">
          <p className="font-medium">No role changes yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Every add, removal and note Gramps records shows here.</p>
        </CardContent>
      )}
    </Card>
  );
}

export function DiscordRolesStatusPanel({ data }: { data: DiscordRolesStatus }) {
  return (
    <>
      <DiscordRolesStatusHeader data={data} />
      <SetupChecks data={data} />
      <SummaryCounts data={data} />
      <LastPasses data={data} />
      <AttentionList items={data.attention} />
      <RecentLedger rows={data.recent} />
    </>
  );
}
