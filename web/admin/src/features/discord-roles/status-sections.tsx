import type { ReactNode } from "react";
import { Badge, Card, Empty, OutcomeBadge, date, type OutcomeState } from "../../components/ui";
import { CopyValue, DataTable } from "../../components/data-table";
import { ago, ahead } from "../supporters/patreon-sync";
import {
  attentionText,
  configuredKey,
  operationLabel,
  providerLabel,
  roleLabels,
  roleSettings,
  triggerLabel,
} from "./labels";
import { ROLE_KINDS, type AttentionItem, type DiscordRolesStatus, type PassSummary, type RoleKind } from "./types";

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;
const valid = (value: string | null | undefined): value is string => !!value && Number.isFinite(Date.parse(value));

/** A relative time with the exact time in its tooltip. */
export function Moment({ at, children }: { at: string; children: ReactNode }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {children}
    </time>
  );
}

/** Off, Ready to switch on, or On, and whether Discord is connected. */
function featureState(data: DiscordRolesStatus) {
  return data.enabled ? "On" : data.ready ? "Ready to switch on" : "Off";
}

/** Null bot facts mean the status could not read the Discord server, so no role was checked. */
const checkedDiscord = (data: DiscordRolesStatus) => data.bot.manageRoles !== null;

export function StatusHeader({ data }: { data: DiscordRolesStatus }) {
  const state = featureState(data);
  const tone = data.ready && data.discordReady ? "good" : "attention";
  const explanation = data.enabled
    ? data.ready
      ? "Gramps keeps the configured roles in step with applications and supporter records, and checks everyone every six hours."
      : checkedDiscord(data)
        ? "Switched on, but a role fails its setup checks below. Gramps skips that role until it is fixed."
        : "Switched on, but Gramps can’t read the Discord server yet, so it changes no roles until it can. See the setup checks below."
    : data.ready
      ? "Switched off in Railway (DISCORD_ROLES_ENABLED=false). Every configured role passes its checks: preview the changes, then set DISCORD_ROLES_ENABLED=true in Railway and restart Gramps. Its first start adds the roles people have already earned."
      : "Switched off in Railway (DISCORD_ROLES_ENABLED=false). Gramps changes no roles. You can still check the setup and preview what would change.";
  return (
    <div className="status-row roles-status">
      {/* Relative times change with every refresh, so they are not announced. */}
      <p className={`status-line ${tone}`} aria-live="off">
        <span>
          Automatic Discord roles: <strong>{state}</strong>
        </span>
        <span>{data.discordReady ? "Discord connected" : "Discord not connected"}</span>
        {data.running && <span>A role check is running now</span>}
        {data.queued > 0 && <span>{plural(data.queued, "person", "people")} waiting for a check</span>}
        {data.fullPassQueued && <span>A check of everyone is queued</span>}
        {valid(data.nextRetryAt) && (
          <span>
            next retry <Moment at={data.nextRetryAt}>{ahead(data.nextRetryAt)}</Moment>
          </span>
        )}
      </p>
      <p className="muted">{explanation}</p>
    </div>
  );
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");

function CheckRow({ title, badge, children }: { title: ReactNode; badge: ReactNode; children?: ReactNode }) {
  return (
    <li>
      <div className="roles-check-head">
        <strong>{title}</strong>
        {badge}
      </div>
      {children}
    </li>
  );
}

function RoleRow({ data, kind }: { data: DiscordRolesStatus; kind: RoleKind }) {
  const role = data.roles[kind];
  const configured = data.configured[configuredKey[kind]];
  const label = roleLabels[kind];
  const optionalOff = kind === "supporter" && !configured;
  // Without a read of the server, the role facts are placeholders, not answers from Discord.
  const checked = checkedDiscord(data);
  const fact = (value: boolean) => (checked ? yesNo(value) : "Not checked");
  const badge = role.assignable ? (
    <Badge kind="good">Ready</Badge>
  ) : optionalOff ? (
    <Badge>Optional · not set up</Badge>
  ) : !checked ? (
    <Badge kind="warn">Not checked</Badge>
  ) : (
    <Badge kind="bad">Needs a fix</Badge>
  );
  return (
    <CheckRow title={`${label} role${kind === "supporter" ? " (optional)" : ""}`} badge={badge}>
      <p className="roles-check-name">
        {role.name ? (
          <>Discord role “{role.name}”</>
        ) : !configured ? (
          "No role ID set"
        ) : checked ? (
          "No Discord role found"
        ) : (
          "Not read from Discord yet"
        )}
        {role.id && (
          <>
            {" · "}
            <CopyValue value={role.id} label={`${label} role ID`} />
          </>
        )}
      </p>
      <dl className="roles-check-facts">
        <div>
          <dt>Configured</dt>
          <dd>{yesNo(configured)}</dd>
        </div>
        <div>
          <dt>Exists in Discord</dt>
          <dd>{fact(role.exists)}</dd>
        </div>
        {role.position !== null && (
          <div>
            <dt>Position</dt>
            <dd>{role.position}</dd>
          </div>
        )}
        <div>
          <dt>Gramps can assign it</dt>
          <dd>{fact(role.assignable)}</dd>
        </div>
      </dl>
      {optionalOff && (
        <p className="muted">
          Optional. Without {roleSettings.supporter}, Gramps skips the Supporter role entirely. It is a Discord role
          only and changes nothing in game.
        </p>
      )}
      {/* Unread, every role carries the same server-level problem; the bot row above shows it once. */}
      {checked && role.problem && (
        <p className={`roles-fix${optionalOff ? " optional" : ""}`}>
          <strong>{optionalOff ? "To add it:" : "Fix:"}</strong> {role.problem}
        </p>
      )}
      {!role.exists && role.candidates && (
        <div className="roles-candidates">
          {role.candidates.length ? (
            <>
              <p>
                Roles named “{label}” in this server. Copy the right one into {roleSettings[kind]}:
              </p>
              <ul aria-label={`Roles named ${label}`}>
                {role.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <span>{candidate.name}</span> <CopyValue value={candidate.id} label={`${label} role ID`} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No role named “{label}” was found in this server.</p>
          )}
        </div>
      )}
    </CheckRow>
  );
}

export function SetupChecks({ data }: { data: DiscordRolesStatus }) {
  const manage = data.bot.manageRoles;
  // The server gives every role the same reason when it could not read Discord.
  const unread =
    data.roles.member.problem ??
    (data.discordReady ? "The Discord server could not be read." : "Discord is not connected yet.");
  return (
    <Card
      title="Setup checks"
      subtitle="Read from Discord with each refresh. Reading the setup changes nothing."
      badge={data.ready ? <Badge kind="good">Ready</Badge> : <Badge kind="warn">Needs a fix</Badge>}
    >
      <ul className="roles-checks" aria-label="Setup checks">
        <CheckRow
          title="Community server"
          badge={data.configured.guild ? <Badge kind="good">Set</Badge> : <Badge kind="bad">Not set</Badge>}
        >
          {!data.configured.guild && (
            <p className="roles-fix">
              <strong>Fix:</strong> Set ADMIN_GUILD_ID to the community Discord server.
            </p>
          )}
        </CheckRow>
        <CheckRow
          title="Bot can manage roles"
          badge={
            manage === null ? (
              <Badge kind="warn">Not checked</Badge>
            ) : manage ? (
              <Badge kind="good">Yes</Badge>
            ) : (
              <Badge kind="bad">No</Badge>
            )
          }
        >
          {manage === false && (
            <p className="roles-fix">
              <strong>Fix:</strong> Give the bot’s role the Manage Roles permission in Server Settings, Roles.
            </p>
          )}
          {manage === null && (
            <p className="roles-fix">
              <strong>Not checked:</strong> {unread}
            </p>
          )}
          {data.bot.highestRolePosition !== null && (
            <p className="muted">
              The bot’s highest role is at position {data.bot.highestRolePosition}. Each role below must have a lower
              position.
            </p>
          )}
        </CheckRow>
        {ROLE_KINDS.map((kind) => (
          <RoleRow key={kind} data={data} kind={kind} />
        ))}
      </ul>
      <p className="roles-checks-summary muted">
        {data.ready
          ? "Every configured role passes its checks."
          : "Fix the items marked “Needs a fix” before switching automatic roles on."}
      </p>
    </Card>
  );
}

export function SummaryCounts({ data }: { data: DiscordRolesStatus }) {
  const { summary } = data;
  const counts: [string, number | null, string][] = [
    ["UNC eligible", summary.memberEligible, "Approved UNC member applications"],
    ["Founders", summary.founders, "Founder records"],
    ["Founders without Discord", summary.foundersWithoutDiscord, "Can’t get the Founder role yet"],
    [
      "Supporters now",
      summary.supporterEligible,
      summary.supporterEligible === null ? "Supporter role not set up" : "Support right now, with Discord linked",
    ],
  ];
  return (
    <dl className="combat-stats roles-counts" aria-label="Role counts">
      {counts.map(([label, value, detail]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {value === null ? "—" : value.toLocaleString()}
            <small>{detail}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PassCounts({ pass }: { pass: PassSummary }) {
  const counts: [string, number][] = [
    ["Added", pass.added],
    ["Removed", pass.removed],
    ["Noted", pass.noted],
    ["Failed", pass.failed],
    ["Blocked", pass.blocked],
    ["Deferred", pass.deferred],
  ];
  return (
    <dl className="sync-counts roles-pass-counts">
      {counts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Pass({ title, pass }: { title: string; pass: PassSummary | null }) {
  const at = pass ? pass.finishedAt || pass.startedAt : null;
  return (
    <section className="roles-pass" aria-label={title}>
      <h4>{title}</h4>
      {pass && valid(at) ? (
        <>
          <p className="muted">
            {triggerLabel(pass.trigger)} · finished <Moment at={at}>{ago(at)}</Moment> ·{" "}
            {plural(pass.users, "person", "people")} checked
          </p>
          {pass.error && <p className="notice warning">{pass.error}</p>}
          <PassCounts pass={pass} />
          {pass.deferred > 0 && (
            <p className="muted">Deferred people are checked again in about a minute (50 changes per check).</p>
          )}
        </>
      ) : (
        <p className="muted">No check has run since Gramps last started.</p>
      )}
    </section>
  );
}

export function LastPasses({ data }: { data: DiscordRolesStatus }) {
  return (
    <Card title="Last role checks" subtitle="Kept in memory since Gramps last started.">
      <div className="card-body roles-passes">
        <Pass title="Last check" pass={data.lastPass} />
        <Pass title="Last full check" pass={data.lastFullPass} />
      </div>
    </Card>
  );
}

function AttentionEntry({ item }: { item: AttentionItem }) {
  const founder = item.kind === "founder_without_discord";
  return (
    <li>
      <div className="roles-attention-who">
        {founder ? (
          <strong>{item.displayName || "Unnamed founder"}</strong>
        ) : item.discordUserId ? (
          <CopyValue value={item.discordUserId} label="Discord user ID" />
        ) : (
          <strong>Unknown member</strong>
        )}
        {founder && item.provider && <Badge>{providerLabel(item.provider)}</Badge>}
        {item.roleKind && <Badge>{roleLabels[item.roleKind]}</Badge>}
      </div>
      <p>{attentionText(item)}</p>
      {valid(item.at) && (
        <small>
          {founder ? "Founder since" : "Noticed"} {date(item.at)}
        </small>
      )}
    </li>
  );
}

export function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <Card
      title="Needs attention"
      subtitle={items.length ? plural(items.length, "item") : "Nothing to follow up"}
      badge={items.length ? <Badge kind="warn">{items.length.toLocaleString()}</Badge> : undefined}
    >
      {items.length ? (
        <ul className="roles-attention" aria-label="Needs attention">
          {items.map((item, index) => (
            <AttentionEntry key={`${item.kind}:${item.discordUserId ?? item.supporterId ?? ""}:${index}`} item={item} />
          ))}
        </ul>
      ) : (
        <Empty title="Nothing needs attention" detail="Founders without Discord and failed changes would show here." />
      )}
    </Card>
  );
}

export function RecentLedger({ rows }: { rows: DiscordRolesStatus["recent"] }) {
  const latest = rows.slice(0, 25);
  return (
    <Card title="Recent role changes" subtitle="The latest 25 rows from the role ledger, newest first.">
      {latest.length ? (
        <DataTable
          label="Recent role changes"
          rows={latest}
          columns={[
            { label: "When", value: (row) => Date.parse(row.createdAt), firstDirection: "descending" },
            { label: "Discord user", value: (row) => row.discordUserId },
            { label: "Role", value: (row) => roleLabels[row.roleKind] },
            { label: "Change", value: (row) => operationLabel(row.operation) },
            { label: "Result" },
          ]}
          renderRow={(row) => (
            <tr key={row.id}>
              <td>
                {date(row.createdAt)}
                <small>{triggerLabel(row.trigger)}</small>
              </td>
              <td>
                <CopyValue value={row.discordUserId} label="Discord user ID" />
              </td>
              <td>{roleLabels[row.roleKind]}</td>
              <td>{operationLabel(row.operation)}</td>
              <td>
                {row.operation === "note" ? <Badge>Noted</Badge> : <OutcomeBadge state={row.state as OutcomeState} />}
                <small className="roles-ledger-message">{row.message}</small>
              </td>
            </tr>
          )}
        />
      ) : (
        <Empty title="No role changes yet" detail="Every add, removal and note Gramps records shows here." />
      )}
    </Card>
  );
}
