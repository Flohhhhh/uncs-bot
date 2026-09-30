/* global document, window, fetch, crypto, FormData, setTimeout */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const state = {
  me: null,
  overview: null,
  page: "overview",
  data: {},
  busy: false,
  action: null,
  query: "",
  stale: true,
  loading: false,
  failedPage: null,
  selectedPlayers: new Set(),
  teamDestinations: {},
  bulkFaction: "",
  teamMove: null,
  lastTeamMove: null,
  nameOnly: false,
  applicationReview: null,
  applicationsDenied: false,
  supportersDenied: false,
  supporterReview: null,
  privateEpoch: 0,
  combatPeriod: "week",
  combatPlayer: "",
  combatEventKind: "all",
  combatWeapon: "",
};
const titles = {
  overview: ["Server overview", "Keep an eye on the match. Take care of the community."],
  players: ["Live players", "The people in your server, and the tools to look after them."],
  combat: ["Combat history", "Recorded kills, player history, and the server leaderboard."],
  whitelist: ["Community whitelist", "Manage queue access while keeping the current community list intact."],
  applications: ["Whitelist applications", "Review community requests and grant access when they’re ready."],
  supporters: ["Community supporters", "Match Patreon support to the crew and review future founder benefits."],
  bans: ["Server bans", "Review restrictions and keep moderation decisions accountable."],
  announcements: ["Announcements", "Keep the crew in the loop, directly from your dashboard."],
  match: ["Match & maps", "Control the current round using the options this server supports."],
  audit: ["Action history", "Who changed what, why they did it, and what the game confirmed."],
};
const actions = {
  kick: ["Kick player", "Disconnect this player from the current game. They can rejoin.", "POST /v1/players/{id}/kick"],
  ban: [
    "Ban player",
    "Add a permanent game ban. The current game build may require the player to be connected.",
    "POST /v1/bans",
  ],
  unban: ["Remove ban", "Restore this player's ability to join the game.", "DELETE /v1/bans/{id}"],
  "whitelist-add": [
    "Add whitelist access",
    "Add this SteamID to the server whitelist. Existing entries and reserved capacity stay as they are.",
    "whitelist",
  ],
  "whitelist-remove": [
    "Remove whitelist access",
    "Explicitly remove this player's existing queue access. This does not ban them from the server.",
    "whitelist",
  ],
  message: ["Message player", "Send a private in-game message to this player.", "POST /v1/players/{id}/message"],
  kill: [
    "Force player respawn",
    "Kill this player's current character. Use only when needed to resolve an issue.",
    "POST /v1/players/{id}/kill",
  ],
  team: [
    "Change player team",
    "Change faction. The player may need to respawn before the change takes effect.",
    "PATCH /v1/players/{id}",
  ],
  broadcast: [
    "Send announcement",
    "Broadcast to everyone currently in the game. This sends immediately.",
    "POST /v1/broadcast",
  ],
  "match-end": [
    "End current match",
    "End this round and follow the server's current map rotation.",
    "POST /v1/match/end",
  ],
  "match-restart": [
    "Restart current match",
    "Reload the current match. This does not restart the server process or apply startup settings.",
    "POST /v1/match/restart",
  ],
  map: ["Change map", "Travel to the selected map after the end-of-match screen.", "POST /v1/match/map"],
  lighting: ["Change lighting", "Apply a lighting preset to the current game.", "PUT /v1/world/lighting"],
};
const modActions = ["kick", "ban", "unban", "message", "kill", "team", "broadcast"];
const destructive = ["ban", "unban", "whitelist-remove", "kill", "team", "match-end", "match-restart", "map"];
const normalize = (route) => route.replace(/\{[^}]+\}/g, "{id}");
function allowed(action) {
  if (
    state.busy ||
    state.stale ||
    !state.me ||
    state.me.role === "viewer" ||
    (state.me.role === "moderator" && !modActions.includes(action))
  )
    return false;
  const caps = state.overview?.capabilities;
  const routes = caps?.routes?.map(normalize) || [];
  if (actions[action][2] === "whitelist")
    return (
      routes.includes(action === "whitelist-add" ? "POST /v1/reserved-slots" : "DELETE /v1/reserved-slots/{id}") ||
      (routes.includes("PUT /v1/config") && caps?.config?.writable !== false)
    );
  return routes.includes(actions[action][2]);
}
function button(action, text, id = "", kind = "secondary small") {
  return `<button class="button ${kind}" data-action="${action}" data-id="${esc(id)}" ${allowed(action) ? "" : 'disabled title="Unavailable for your role, connection, or server build"'}>${esc(text)}</button>`;
}
function badge(text, kind = "neutral") {
  return `<span class="pill ${kind}">${esc(text)}</span>`;
}
function empty(title, detail = "") {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
}
function metric(label, value, note, word = false) {
  return `<div class="metric"><div class="metric-label">${label}<span>↗</span></div><div class="metric-value ${word ? "word" : ""}">${value}</div><div class="metric-note">${note}</div></div>`;
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
// Wardogs' current RCON uses faction names for moves, but RED/BLU/GRN in its roster.
// Match those codes only against the official colors returned by this live server.
const factionColors = {
  "#d86060": { code: "RED", label: "Red" },
  "#5b95d8": { code: "BLU", label: "Blue" },
  "#7bc462": { code: "GRN", label: "Green" },
};
function liveFactions() {
  const teams = state.overview?.status.factionScores || [];
  return teams
    .filter((team) => team.name && teams.filter((other) => other.name === team.name).length === 1)
    .map((team) => {
      const raw = String(team.colorHex || "").toLowerCase();
      const color = /^#?[0-9a-f]{6}$/.test(raw) ? `#${raw.replace(/^#/, "")}` : "";
      const known = factionColors[color];
      const uniqueColor =
        teams.filter(
          (other) =>
            String(other.colorHex || "")
              .toLowerCase()
              .replace(/^#/, "") === color.slice(1),
        ).length === 1;
      return {
        name: team.name,
        color,
        code: known && uniqueColor ? known.code : "",
        label: known && uniqueColor ? `${known.label} · ${team.name}` : team.name,
      };
    });
}
function playerFaction(player) {
  const teams = liveFactions();
  return (
    teams.find((team) => team.name === player.faction) ||
    teams.find((team) => team.code && team.code === String(player.faction || "").toUpperCase())
  );
}
function factionChip(team, fallback = "Choosing team") {
  if (!team) return `<span class="faction-chip">${esc(fallback)}</span>`;
  const swatch = team.color
    ? `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="${team.color}" /></svg>`
    : "";
  return `<span class="faction-chip">${swatch}${esc(team.label)}</span>`;
}
function factionOptions(selected = "", excluded = "") {
  return (
    '<option value="">Choose team…</option>' +
    liveFactions()
      .filter((team) => team.name !== excluded)
      .map(
        (team) =>
          `<option value="${esc(team.name)}" ${selected === team.name ? "selected" : ""}>${esc(team.label)}</option>`,
      )
      .join("")
  );
}
function playerRows(players, compact = false) {
  return players.map((p) => {
    const current = playerFaction(p);
    const destination = state.teamDestinations[p.steamId] || "";
    const canMove = allowed("team") && liveFactions().some((team) => team.name !== current?.name);
    const selection = compact
      ? ""
      : `<td class="select-cell"><input type="checkbox" data-select-player="${esc(p.steamId)}" aria-label="Select ${esc(p.name)}" ${state.selectedPlayers.has(p.steamId) ? "checked" : ""} ${canMove ? "" : "disabled"} /></td>`;
    const move = `<div class="team-row-controls"><select data-team-destination="${esc(p.steamId)}" aria-label="Destination team for ${esc(p.name)}" ${canMove ? "" : "disabled"}>${factionOptions(destination, current?.name)}</select><button class="button secondary small" data-team-move="${esc(p.steamId)}" ${canMove && destination && destination !== current?.name ? "" : "disabled"}>Move</button></div>`;
    return `<tr>${selection}<td><div class="player-name"><span class="player-icon">${esc(p.name.slice(0, 2).toUpperCase())}</span><div><strong>${esc(p.name)}</strong><small>${esc(p.steamId)}</small></div></div></td><td>${factionChip(current, p.faction || "Choosing team")}</td><td>${esc(p.kills ?? "—")} / ${esc(p.deaths ?? "—")}</td><td>${esc(p.pingMs ?? "—")} <span class="muted">ms</span></td><td><div class="row-actions">${compact ? '<button class="text-button" data-page="players">View player →</button>' : `${move}<button class="button secondary small" data-manage="${esc(p.steamId)}" ${state.busy || state.stale || state.me.role === "viewer" ? "disabled" : ""}>More</button>`}</div></td></tr>`;
  });
}
function filter(rows, fields) {
  const q = state.query.toLowerCase();
  return rows.filter((row) =>
    fields.some((field) =>
      String(row[field] ?? "")
        .toLowerCase()
        .includes(q),
    ),
  );
}
function visiblePlayers() {
  const query = state.query.toLowerCase();
  return (state.overview?.players || []).filter((player) => {
    const fields = state.nameOnly
      ? [player.name]
      : [player.name, player.steamId, player.faction, playerFaction(player)?.label];
    return fields.some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(query),
    );
  });
}
function toolbar(placeholder, action = "") {
  return `<div class="toolbar"><label class="search"><input id="search" type="search" value="${esc(state.query)}" placeholder="${placeholder}" aria-label="${placeholder}" /></label>${action}</div>`;
}
const applicationStatuses = {
  pending: "Awaiting review",
  processing: "Processing",
  approved: "Approved",
  declined: "Declined",
  needs_review: "Needs review",
};
const applicationRelationships = {
  unc_member: "UNC member (self-reported)",
  friend_regular: "Friend or server regular (self-reported)",
  new_player: "New player (self-reported)",
};
function applicationStatus(record) {
  return badge(
    applicationStatuses[record.status] || "Needs review",
    record.status === "approved" ? "good" : ["needs_review", "processing"].includes(record.status) ? "warn" : "neutral",
  );
}
function displayDate(value) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}
const combatPeriods = { day: "Last 24 hours", week: "Last 7 days", month: "Last 30 days" };
function combatViewKey() {
  return `${state.combatPeriod}:${state.combatPlayer}`;
}
function countText(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
}
function ratioText(player) {
  return typeof player?.kd === "number" && Number.isFinite(player.kd) ? player.kd.toFixed(2) : "—";
}
function headshotShare(player) {
  return player.kills > 0 && typeof player.headshotKills === "number"
    ? `${Math.round((player.headshotKills / player.kills) * 100)}%`
    : "—";
}
function combatPlayerLink(steamId, name) {
  const label = esc(name || steamId || "Unknown player");
  return /^7656119\d{10}$/.test(steamId || "")
    ? `<button class="combat-player-link" data-combat-player="${esc(steamId)}">${label}</button>`
    : label;
}
function combatEventRows(events) {
  return events.map((event) => {
    const context = [event.headshot ? badge("Headshot") : "", event.suicide ? badge("Suicide") : ""]
      .filter(Boolean)
      .join(" ");
    return `<tr><td class="combat-time">${esc(displayDate(event.receivedAt))}${event.mapName ? `<small>${esc(event.mapName)}</small>` : ""}</td><td><strong>${event.killerSteamId ? combatPlayerLink(event.killerSteamId, event.killerName) : esc(event.killerName || "No killer reported")}</strong><small>${esc(event.killerSteamId || "")}</small></td><td><strong>${combatPlayerLink(event.victimSteamId, event.victimName)}</strong><small>${esc(event.victimSteamId)}</small></td><td class="combat-cause">${esc(event.cause || "Not reported")}</td><td>${typeof event.distanceMeters === "number" && Number.isFinite(event.distanceMeters) ? `${event.distanceMeters.toLocaleString(undefined, { maximumFractionDigits: 1 })} m` : "—"}</td><td>${context || "—"}</td></tr>`;
  });
}
function combatPage() {
  const controls = `<div class="combat-toolbar"><div class="period-switch" role="group" aria-label="Combat history period">${Object.entries(
    combatPeriods,
  )
    .map(
      ([period, label]) =>
        `<button class="${state.combatPeriod === period ? "active" : ""}" data-combat-period="${period}" aria-pressed="${state.combatPeriod === period}">${label}</button>`,
    )
    .join(
      "",
    )}</div>${state.combatPlayer ? '<button class="button secondary small" data-combat-back>← Server leaderboard</button>' : ""}</div>`;
  const data = state.data.combat;
  if (!data || data._viewKey !== combatViewKey())
    return (
      controls +
      empty(
        state.failedPage === "combat" ? "Combat history could not be loaded" : "Loading combat history…",
        state.failedPage === "combat" ? "Use Refresh to try again. No empty history has been assumed." : "",
      )
    );
  const leaderboard = data.leaderboard || [];
  const events = data.events || [];
  const query = state.query.toLowerCase();
  const foundPlayers = leaderboard.filter((player) =>
    [player.name, player.steamId].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(query),
    ),
  );
  const weapons = [...new Set(events.map((event) => event.cause).filter(Boolean))].sort();
  const filteredEvents = events.filter(
    (event) =>
      [event.killerName, event.killerSteamId, event.victimName, event.victimSteamId, event.cause].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(query),
      ) &&
      (state.combatEventKind !== "headshot" || event.headshot) &&
      (!state.combatWeapon || event.cause === state.combatWeapon),
  );
  const summary = data.player;
  const feedLabel = !data.enabled
    ? "FEED NOT CONNECTED"
    : data.feedStatus === "receiving"
      ? "FEED RECEIVING"
      : data.feedStatus === "quiet"
        ? "NO RECENT BATCH"
        : "WAITING FOR FEED";
  const feedKind = data.enabled && data.feedStatus === "receiving" ? "good" : "neutral";
  let html =
    controls +
    `<div class="combat-coverage"><div>${badge(state.failedPage === "combat" ? "FEED STATUS UNAVAILABLE" : feedLabel, state.failedPage === "combat" ? "warn" : feedKind)}<p>${esc(data.coverageNote || "Only recorded combat events are included in this view.")}${data.feedStatus === "quiet" ? " A quiet feed does not mean the server is offline." : ""}</p><p class="combat-window">Rolling window starts ${esc(displayDate(data.windowStartedAt))}. Periods use event receipt times.</p></div><dl><div><dt>Tracking started</dt><dd>${esc(displayDate(data.trackingStartedAt))}</dd></div><div><dt>Last batch received</dt><dd>${esc(displayDate(data.lastReceivedAt))}</dd></div></dl></div>`;
  if (state.combatPlayer) {
    html += `<div class="combat-player-heading"><div><p class="eyebrow">PLAYER HISTORY / ${esc(combatPeriods[state.combatPeriod].toUpperCase())}</p><h2>${esc(summary?.name || leaderboard.find((player) => player.steamId === state.combatPlayer)?.name || "Player history")}</h2><p class="muted">${esc(state.combatPlayer)}</p></div>${badge("RECORDED EVENTS")}</div><div class="metrics">${metric("KILLS", countText(summary?.kills), "Recorded kills in this period")}${metric("DEATHS", countText(summary?.deaths), "Recorded deaths in this period")}${metric("K / D", ratioText(summary), summary?.deaths === 0 ? "No recorded deaths in this period" : "Per recorded death")}${metric("HEADSHOT KILLS", countText(summary?.headshotKills), summary ? `${headshotShare(summary)} of recorded kills` : "Share of kills, not shooting accuracy")}</div>`;
  } else {
    html += `<div class="metrics">${metric("RECORDED KILLS", countText(data.totals?.kills), "Player kills, excluding suicides")}${metric("RECORDED DEATHS", countText(data.totals?.deaths), "Deaths in the captured feed")}${metric("PLAYERS RECORDED", countText(data.totals?.players), "Distinct players in this period")}${metric("HEADSHOT KILLS", countText(data.totals?.headshotKills), "Recorded headshot kill events")}</div>`;
  }
  html += toolbar("Search player, SteamID, or weapon");
  if (!state.combatPlayer)
    html += `<div class="card combat-leaderboard"><div class="card-header"><div><h3>Server leaderboard</h3><p>${esc(combatPeriods[state.combatPeriod])} · up to 100 players · select a player to view their history</p></div>${badge("RECORDED KILLS")}</div>${
      foundPlayers.length
        ? table(
            ["PLAYER", "KILLS", "DEATHS", "K / D", "HEADSHOT KILLS"],
            foundPlayers.map(
              (player) =>
                `<tr><td><strong>${combatPlayerLink(player.steamId, player.name)}</strong><small>${esc(player.steamId)}</small></td><td>${countText(player.kills)}</td><td>${countText(player.deaths)}</td><td>${ratioText(player)}</td><td>${countText(player.headshotKills)} <span class="muted">· ${headshotShare(player)}</span></td></tr>`,
            ),
          )
        : empty(
            leaderboard.length ? "No matching players" : "No recorded player stats yet",
            leaderboard.length
              ? "Try another name or SteamID."
              : data.connected
                ? "Player history will appear as combat events arrive."
                : "Connect the combat feed to begin recording player history. Earlier matches are not reconstructed.",
          )
    }<p class="combat-stat-note">Headshot percentage is a share of recorded kills. K/D is shown as — when no deaths were recorded.</p></div>`;
  html += `<div class="card"><div class="card-header"><div><h3>${state.combatPlayer ? "Player combat events" : "Recent combat events"}</h3><p>${filteredEvents.length} shown from the latest ${events.length} events (up to 100) · timestamps show receipt time</p></div></div><div class="combat-filters"><label>Event type<select id="combat-event-kind"><option value="all" ${state.combatEventKind === "all" ? "selected" : ""}>All events</option><option value="headshot" ${state.combatEventKind === "headshot" ? "selected" : ""}>Headshot kills</option></select></label><label>Weapon / cause<select id="combat-weapon"><option value="">All reported causes</option>${weapons.map((weapon) => `<option value="${esc(weapon)}" ${state.combatWeapon === weapon ? "selected" : ""}>${esc(weapon)}</option>`).join("")}</select></label><p>Filters apply to these recent events. Stats cover the full recorded period.</p></div>${filteredEvents.length ? table(["RECEIVED", "KILLER", "VICTIM", "WEAPON / CAUSE", "DISTANCE", "CONTEXT"], combatEventRows(filteredEvents)) : empty(events.length ? "No events match these filters" : "No combat events recorded in this period", events.length ? "Change the search, event type, or weapon filter." : "This is recorded history; an empty feed does not mean nobody played.")}</div>`;
  return html;
}
function supporterPayment(payment) {
  if (!payment) return "No payment evidence recorded";
  const amount =
    typeof payment.amountCents === "number"
      ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency || "currency not recorded"}`
      : "Amount not established";
  const evidence =
    payment.source === "manual_receipt"
      ? `receipt checked by staff · ${payment.firstSuccessfulPaymentVerified ? "first payment history checked" : "first payment history not confirmed"}`
      : "provider status only";
  return `${amount} · ${evidence}`;
}
function supporterStatus(record) {
  const labels = {
    active_patron: "Active membership",
    declined_patron: "Payment issue",
    former_patron: "Former member",
  };
  return badge(
    labels[record.patronStatus] || record.patronStatus || "Status not supplied",
    record.patronStatus === "declined_patron" ? "warn" : "neutral",
  );
}
function supporterFounderReady(record) {
  const policy = state.data.supporters?.founderPolicy;
  const payment = record.founderEligiblePayment;
  const paidAt = Date.parse(payment?.paidAt || "");
  return Boolean(
    policy?.configured &&
    record.identityState === "staff_linked" &&
    record.discordId &&
    record.steamId &&
    payment?.source === "manual_receipt" &&
    payment.verificationState === "verified" &&
    payment.firstSuccessfulPaymentVerified === true &&
    payment.currency === policy.currency &&
    payment.amountCents >= policy.amountCents &&
    paidAt >= Date.parse(policy.startsAt) &&
    paidAt < Date.parse(policy.endsAt) &&
    !record.founder,
  );
}
function supporterPage() {
  if (state.me?.role !== "admin" || state.supportersDenied) return empty("Administrator access required");
  const data = state.data.supporters;
  if (!data?.supporters)
    return empty(
      state.failedPage === "supporters" ? "Supporter records could not be loaded" : "Loading supporters…",
      state.failedPage === "supporters" ? "Refresh to try again. No empty list has been assumed." : "",
    );
  const records = data.supporters;
  const rows = filter(records, ["displayName", "patreonMemberId", "discordId", "steamId"]);
  const founders = records.filter((record) => record.founder).length;
  const pending = records.filter((record) => record.reviewState !== "verified").length;
  const unlinked = records.filter((record) => record.identityState !== "staff_linked").length;
  const policy = data.founderPolicy;
  const windowDate = (value) =>
    new Date(value).toLocaleString(undefined, { timeZone: "America/New_York", timeZoneName: "short" });
  const window = policy?.configured
    ? `${windowDate(policy.startsAt)} → ${windowDate(policy.endsAt)} (end exclusive)`
    : "15 days from launch · dates not set";
  return `<div class="supporter-intro"><div><p class="eyebrow">PATREON / PRIVATE STAFF RECORDS</p><h2>THANK THE CREW.<br /><span>KEEP THE PROMISE.</span></h2><p>Monthly support and permanent founder recognition have separate records. A founder promise does not expire when a membership ends.</p></div><div class="supporter-launch"><span class="eyebrow">FOUNDER WINDOW</span><strong>${esc(window)}</strong><small>${policy?.configured ? "Use the completed payment date, not the date a membership appeared here." : "The launch dates must be set before any founder promise can be recorded."}</small>${badge(data.enabled && data.configured ? "INTEGRATION CONFIGURED" : "NOT CONNECTED", data.enabled && data.configured ? "neutral" : "warn")}</div></div><div class="notice info"><strong>Future benefit only.</strong> Founder recognition records lifetime standard whitelist access for when Wardogs queue tiers launch. No whitelist, priority tier, or Discord role is granted from this page. Current free whitelist access stays in place.</div>${data.note ? `<p class="supporter-note">${esc(data.note)}</p>` : ""}<div class="application-counts supporter-counts"><span><strong>${pending}</strong> awaiting review</span><span><strong>${unlinked}</strong> accounts to match</span><span><strong>${founders}</strong> founder promises</span><span>Counts are for the records shown</span></div>${toolbar("Search Patreon name, member ID, Discord ID, or SteamID")}<div class="card"><div class="card-header"><div><h3>Patreon supporters</h3><p>Membership status is not proof of a completed payment. Open a record to check evidence.</p></div>${badge("ADMIN ONLY")}</div>${
    rows.length
      ? table(
          ["SUPPORTER", "RECURRING STATUS", "ACCOUNT MATCH", "FOUNDER RECORD", ""],
          rows.map(
            (record) =>
              `<tr><td><strong>${esc(record.displayName || "Patreon member")}</strong><small>Member ${esc(record.patreonMemberId)}</small><small>${record.reviewState === "verified" ? "Observation reviewed" : "Needs staff review"}</small></td><td>${supporterStatus(record)}<small>Latest charge: ${esc(record.lastChargeStatus || "not supplied")}</small></td><td>${badge(record.identityState === "staff_linked" ? "Staff-linked" : "Not linked", record.identityState === "staff_linked" ? "neutral" : "warn")}<small>${esc(record.steamId || "SteamID not recorded")}</small></td><td>${badge(record.founder ? "Permanent promise" : "Not recorded", record.founder ? "good" : "neutral")}<small>${record.founder ? "Waiting for game update" : "Requires payment review"}</small></td><td><button class="button secondary small" data-supporter="${esc(record.id)}">Review supporter</button></td></tr>`,
          ),
        )
      : empty(
          records.length ? "No matching supporters" : "No supporter records yet",
          records.length
            ? "Try another name or account ID."
            : "Records will appear after Patreon is connected and sends membership updates. A payment has not been assumed.",
        )
  }</div>`;
}
function supporterDetails(record) {
  const payment = record.latestPayment;
  return `<div class="application-identity"><div><span class="eyebrow">PATREON MEMBER RECORD</span><strong>${esc(record.displayName || "Patreon member")}</strong><small>${esc(record.patreonMemberId)}</small></div>${supporterStatus(record)}</div><dl class="application-details"><div><dt>Latest membership observation</dt><dd>${esc(displayDate(record.observedAt))}<small>${record.reviewState === "verified" ? "Reviewed by staff; this is not payment or account ownership verification." : "Awaiting staff review."}</small></dd></div><div><dt>Latest charge status</dt><dd>${esc(record.lastChargeStatus || "Not supplied")}<small>${esc(displayDate(record.lastChargeAt))}</small></dd></div><div><dt>Discord account</dt><dd>${esc(record.discordId || "Not linked")}<small>${record.identityState === "staff_linked" ? "Matched by staff; not verified through Discord sign-in." : "Record the account after confirming the member’s identity."}</small></dd></div><div><dt>SteamID64</dt><dd>${esc(record.steamId || "Not linked")}<small>Staff-entered; Steam ownership is not verified by this page.</small></dd></div><div><dt>Payment evidence</dt><dd>${esc(supporterPayment(payment))}${payment ? `<small>${esc(displayDate(payment.paidAt))}</small><small>Reference: ${esc(payment.reference || "Not recorded")}</small>` : ""}</dd></div><div><dt>Permanent founder record</dt><dd>${record.founder ? `Recorded ${esc(displayDate(record.founder.awardedAt))}<small>Lifetime standard whitelist promise. Awaiting the game’s queue-tier update; no access activated.</small>` : "Not recorded"}</dd></div></dl>`;
}
function openSupporter(id, decision = "") {
  if (state.busy || state.me?.role !== "admin" || state.supportersDenied) return;
  const data = state.data.supporters;
  const record = data?.supporters.find((entry) => entry.id === id);
  if (
    !record ||
    (decision &&
      (!["link", "payment", "founder", "review"].includes(decision) ||
        !data.enabled ||
        state.failedPage === "supporters" ||
        (decision === "founder" && !supporterFounderReady(record))))
  )
    return;
  state.action = null;
  state.applicationReview = null;
  state.teamMove = null;
  state.supporterReview = { record, decision, id: crypto.randomUUID(), submitted: false, epoch: state.privateEpoch };
  const form = $("action-form"),
    reason = form.querySelector('textarea[name="reason"]');
  form.reset();
  $("action-dialog").classList.remove("team-dialog", "application-dialog");
  $("action-dialog").classList.add("supporter-dialog");
  document.querySelector(".dialog-top .eyebrow").textContent = "SUPPORTER REVIEW";
  const labels = {
    link: "Match supporter accounts",
    payment: "Record a checked payment",
    founder: "Record founder promise",
    review: "Mark observation reviewed",
  };
  $("action-title").textContent = labels[decision] || "Supporter record";
  $("action-description").textContent =
    decision === "payment"
      ? "Check the completed payment in Patreon first. Membership status, tier price, and a screenshot alone do not establish receipt of funds."
      : decision === "founder"
        ? "Record the permanent standard whitelist promise against this checked payment. The benefit remains inactive until the game update and a separate release decision."
        : decision === "link"
          ? "Confirm which Discord and Steam accounts belong with this Patreon member. This saves a staff-reviewed match; it does not authenticate either account."
          : decision === "review"
            ? "Record that you reviewed this membership observation. This does not verify payment or grant a benefit."
            : "Review account matching and payment evidence before recording any future benefit.";
  let fields = supporterDetails(record);
  if (decision === "founder") {
    const payment = record.founderEligiblePayment;
    fields += `<div class="notice"><strong>Payment supporting this founder promise</strong><br />${esc(supporterPayment(payment))}<br />${esc(displayDate(payment.paidAt))}<br />Reference: ${esc(payment.reference)}</div>`;
  }
  if (decision === "link")
    fields += `<label>Discord user ID<input name="discordId" required pattern="[0-9]{17,20}" maxlength="20" inputmode="numeric" value="${esc(record.discordId || "")}" placeholder="Discord user ID, not a display name" /></label><label>SteamID64<input name="steamId" required pattern="7656119[0-9]{10}" maxlength="17" inputmode="numeric" value="${esc(record.steamId || "")}" placeholder="7656119…" /></label>`;
  if (decision === "payment")
    fields += `<div class="supporter-form-grid"><label>Completed payment date and time<input type="datetime-local" name="paidAt" required step="60" /><small>Your local timezone: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Recorded as UTC.</small></label><label>Gross completed amount · USD<input type="number" name="amount" required min="0.01" step="0.01" max="1000000" placeholder="5.00" /></label></div><label>Patreon payment reference<input name="reference" required minlength="3" maxlength="120" autocomplete="off" placeholder="Reference from the completed Patreon payment" /></label><label class="supporter-check"><input type="checkbox" name="completedPaymentVerified" required /><span>I checked this completed payment in Patreon and matched it to this member.</span></label><label class="supporter-check"><input type="checkbox" name="firstSuccessfulPaymentVerified" /><span>I checked Patreon history and confirmed this was their first successful payment.<small>Optional for recording a renewal. Required for founder eligibility.</small></span></label>`;
  if (!decision) {
    const disabled = !data.enabled || state.failedPage === "supporters";
    fields += `<div class="supporter-next"><h3>Next steps</h3><p>Match the accounts, check a completed payment, then review founder eligibility during the configured launch window.</p><div class="action-list">${[
      ["link", record.identityState === "staff_linked" ? "Review account match" : "Match accounts"],
      ["payment", "Record checked payment"],
      ["review", "Mark observation reviewed"],
    ]
      .map(
        ([action, text]) =>
          `<button type="button" class="button secondary small" data-supporter-decision="${action}" data-supporter-id="${esc(record.id)}" ${disabled ? "disabled" : ""}>${text}</button>`,
      )
      .join(
        "",
      )}<button type="button" class="button primary small" data-supporter-decision="founder" data-supporter-id="${esc(record.id)}" ${disabled || !supporterFounderReady(record) ? 'disabled title="Requires a configured launch window, matched accounts, and a qualifying checked payment"' : ""}>${record.founder ? "Founder promise recorded" : "Record founder promise"}</button></div>${!data.founderPolicy?.configured ? '<p class="muted">Founder dates have not been set. No founder promise can be recorded yet.</p>' : ""}</div>`;
  }
  $("action-fields").innerHTML = fields;
  reason.parentElement.hidden = !decision;
  reason.disabled = !decision;
  reason.value = "";
  $("confirmation").innerHTML = decision
    ? `<div class="application-confirm"><strong>${esc(labels[decision])}</strong><span>Patreon member ${esc(record.patreonMemberId)}</span><span>This records staff evidence only. No game or Discord access changes.</span></div>`
    : "";
  $("action-error").hidden = true;
  $("submit-action").hidden = !decision;
  $("submit-action").disabled = !decision;
  $("submit-action").textContent = decision ? "Save reviewed record" : "Save";
  $("cancel-dialog").textContent = decision ? "Cancel" : "Close";
  $("cancel-dialog").disabled = false;
  $("close-dialog").disabled = false;
  if (!$("action-dialog").open) $("action-dialog").showModal();
}
async function submitSupporterReview(values) {
  const review = state.supporterReview;
  if (state.busy || state.me?.role !== "admin" || state.supportersDenied || !review?.decision || review.submitted)
    return;
  const input = {
    id: review.id,
    version: review.record.version,
    reason: values.get("reason"),
    confirm: review.record.patreonMemberId,
  };
  if (review.decision === "link") {
    input.discordId = values.get("discordId");
    input.steamId = values.get("steamId");
  }
  if (review.decision === "payment") {
    const paidAt = new Date(values.get("paidAt"));
    const amount = Number(values.get("amount"));
    if (!Number.isFinite(paidAt.getTime()) || !Number.isFinite(amount) || amount <= 0) return;
    Object.assign(input, {
      paidAt: paidAt.toISOString(),
      amountCents: Math.round(amount * 100),
      currency: "USD",
      reference: values.get("reference"),
      completedPaymentVerified: values.get("completedPaymentVerified") === "on",
      firstSuccessfulPaymentVerified: values.get("firstSuccessfulPaymentVerified") === "on",
    });
  }
  if (review.decision === "founder") input.paymentId = review.record.founderEligiblePayment?.id;
  review.submitted = true;
  lockTeamMove(true);
  $("submit-action").disabled = true;
  $("submit-action").textContent = "Saving record…";
  $("cancel-dialog").disabled = true;
  $("close-dialog").disabled = true;
  $("action-error").hidden = true;
  try {
    const result = await api(`supporters/${encodeURIComponent(review.record.id)}/${review.decision}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (state.supporterReview !== review || review.epoch !== state.privateEpoch || state.me?.role !== "admin") return;
    if (!result.ok || !result.supporter)
      throw new Error("The saved record could not be confirmed. Refresh before another review.");
    review.record = result.supporter;
    $("action-title").textContent = "Supporter record saved";
    $("action-description").textContent = "Your review has been recorded. No game access or Discord role was changed.";
    $("action-fields").innerHTML = supporterDetails(result.supporter);
    $("result").textContent = `Supporter review recorded. Review ID: ${review.id}`;
    $("result").className = "notice";
    $("result").hidden = false;
  } catch (error) {
    if (state.supporterReview !== review || review.epoch !== state.privateEpoch || state.me?.role !== "admin") return;
    $("action-title").textContent = "Save result not confirmed";
    $("action-description").textContent =
      "Close this record and refresh to check what was saved before submitting another review.";
    $("action-error").textContent = `${error.message} Review ID: ${review.id}`;
    $("action-error").hidden = false;
  } finally {
    lockTeamMove(false);
    if (state.supporterReview === review) {
      $("submit-action").hidden = true;
      $("confirmation").innerHTML = "";
      $("action-form").querySelector('textarea[name="reason"]').parentElement.hidden = true;
      $("cancel-dialog").textContent = "Close";
      $("cancel-dialog").disabled = false;
      $("close-dialog").disabled = false;
    }
    await refresh();
  }
}
function applicationPage() {
  if (state.me?.role !== "admin") return empty("Administrator access required");
  const records = state.data.applications?.applications;
  if (!records)
    return empty(
      state.failedPage === "applications" ? "Applications could not be loaded" : "Loading applications…",
      state.failedPage === "applications" ? "Use Refresh to try again." : "",
    );
  const rows = filter(records, ["discordDisplayName", "discordUserId", "steamId"]);
  const pending = records.filter((record) => record.status === "pending").length;
  const needsReview = records.filter((record) => record.status === "needs_review").length;
  return `<div class="application-counts"><span><strong>${pending}</strong> awaiting review in this list</span><span><strong>${needsReview}</strong> need follow-up</span><span>Up to 100 requests; awaiting review first</span></div>${toolbar("Search Discord name, Discord ID, or SteamID")}<div class="card"><div class="card-header"><div><h3>Community requests</h3><p>Email addresses are private to administrators and shown inside each request.</p></div>${badge("ADMIN ONLY")}</div>${
    rows.length
      ? table(
          ["DISCORD / STEAMID", "COMMUNITY CONNECTION", "SUBMITTED", "STATUS", ""],
          rows.map(
            (record) =>
              `<tr><td><strong>${esc(record.discordDisplayName)}</strong><small>${esc(record.steamId)}</small></td><td class="application-relationship">${esc(applicationRelationships[record.relationship] || "Not recorded")}</td><td>${esc(new Date(record.submittedAt).toLocaleDateString())}</td><td>${applicationStatus(record)}</td><td><button class="button secondary small" data-application="${esc(record.id)}">View request</button></td></tr>`,
          ),
        )
      : empty(
          "No matching applications",
          records.length ? "Try another Discord name or SteamID." : "New website requests will appear here.",
        )
  }</div>`;
}
function applicationDetails(record) {
  const consent = record.contactConsent ? `Given · ${displayDate(record.contactConsentAt)}` : "Not given";
  return `<div class="application-identity"><div><span class="eyebrow">AUTHENTICATED DISCORD ACCOUNT</span><strong>${esc(record.discordDisplayName)}</strong><small>${esc(record.discordUserId)}</small></div>${applicationStatus(record)}</div><dl class="application-details"><div><dt>SteamID64</dt><dd><strong>${esc(record.steamId)}</strong><small>Self-reported · ownership not verified</small></dd></div><div><dt>Community connection</dt><dd>${esc(applicationRelationships[record.relationship] || "Not recorded")}<small>This answer does not assign a Discord role or priority tier.</small></dd></div><div><dt>Email · private</dt><dd class="application-email">${esc(record.email || "Not provided")}<small>${record.emailVerified ? "Verified by the application service" : "Unverified email address"}</small></dd></div><div><dt>Application contact consent</dt><dd>${esc(consent)}</dd></div><div><dt>Rules accepted</dt><dd>${esc(displayDate(record.rulesAcceptedAt))}</dd></div><div><dt>Submitted</dt><dd>${esc(displayDate(record.submittedAt))}</dd></div>${record.reviewedAt ? `<div><dt>Last staff review</dt><dd>${esc(displayDate(record.reviewedAt))}<small>${esc(record.reviewReason || "")}</small></dd></div>` : ""}</dl>${record.lastActionState ? `<div class="notice ${record.status === "approved" ? "" : "warning"}"><strong>Last action: ${esc(record.lastActionState)}</strong><br />${esc(record.lastActionMessage || "No additional details were recorded.")}${record.actionId ? `<small class="application-action-id">${record.status === "declined" ? "Decision" : "Whitelist action"} ${esc(record.actionId)}</small>` : ""}</div>` : ""}`;
}
function openApplication(id, decision = "") {
  if (state.busy || state.me?.role !== "admin") return;
  const record = state.data.applications?.applications.find((application) => application.id === id);
  if (
    !record ||
    (decision &&
      (!["approve", "decline", "recheck"].includes(decision) ||
        record.status !== (decision === "recheck" ? "needs_review" : "pending") ||
        state.failedPage === "applications"))
  )
    return;
  state.teamMove = null;
  state.action = null;
  state.supporterReview = null;
  state.applicationReview = { record, decision, id: crypto.randomUUID(), submitted: false };
  const form = $("action-form"),
    reason = form.querySelector('textarea[name="reason"]');
  form.reset();
  $("action-dialog").classList.remove("team-dialog", "supporter-dialog");
  $("action-dialog").classList.add("application-dialog");
  document.querySelector(".dialog-top .eyebrow").textContent = "APPLICATION REVIEW";
  $("action-title").textContent =
    decision === "approve"
      ? "Approve whitelist access"
      : decision === "decline"
        ? "Decline application"
        : decision === "recheck"
          ? "Recheck live whitelist"
          : "Whitelist application";
  $("action-description").textContent =
    decision === "approve"
      ? "Review the Discord account and requested SteamID below. Approval adds this SteamID to the existing whitelist; it does not change anyone else’s access."
      : decision === "decline"
        ? "Record why this application is declined. This does not remove any existing whitelist access or ban the player."
        : decision === "recheck"
          ? "Read the running whitelist to check whether this SteamID already has access. This does not add, remove, or resend anything to the game."
          : "Review the request and the applicant’s contact details.";
  $("action-fields").innerHTML =
    applicationDetails(record) +
    (!decision && record.status === "pending"
      ? `<div class="action-list"><button type="button" class="button primary" data-application-decision="approve" data-application-id="${esc(record.id)}" ${state.failedPage === "applications" ? "disabled" : ""}>Review approval</button><button type="button" class="button secondary" data-application-decision="decline" data-application-id="${esc(record.id)}" ${state.failedPage === "applications" ? "disabled" : ""}>Decline request</button></div>`
      : !decision && record.status === "needs_review"
        ? `<p class="muted">Approval has not been confirmed. Recheck the running whitelist without sending another grant.</p><button type="button" class="button secondary" data-application-decision="recheck" data-application-id="${esc(record.id)}" ${state.failedPage === "applications" ? "disabled" : ""}>Recheck live whitelist</button>`
        : "");
  reason.parentElement.hidden = !decision;
  reason.disabled = !decision;
  reason.value =
    decision === "approve"
      ? "Website whitelist application reviewed and approved."
      : decision === "recheck"
        ? "Recheck the existing application against the running whitelist."
        : "";
  $("confirmation").innerHTML = decision
    ? `<div class="application-confirm"><strong>${decision === "approve" ? "Grant whitelist access to" : decision === "recheck" ? "Check existing access for" : "Decline the application from"} ${esc(record.discordDisplayName)}</strong><span>SteamID64 ${esc(record.steamId)}</span></div>`
    : "";
  $("action-error").hidden = true;
  $("submit-action").hidden = !decision;
  $("submit-action").disabled = !decision;
  $("submit-action").textContent =
    decision === "approve"
      ? "Approve this SteamID"
      : decision === "recheck"
        ? "Check running whitelist"
        : "Confirm decline";
  $("cancel-dialog").textContent = decision ? "Cancel" : "Close";
  $("cancel-dialog").disabled = false;
  $("close-dialog").disabled = false;
  if (!$("action-dialog").open) $("action-dialog").showModal();
}
async function submitApplicationReview(reason) {
  const review = state.applicationReview;
  if (state.busy || state.me?.role !== "admin" || !review?.decision || review.submitted) return;
  review.submitted = true;
  lockTeamMove(true);
  $("submit-action").disabled = true;
  $("submit-action").textContent = "Recording decision…";
  $("cancel-dialog").disabled = true;
  $("close-dialog").disabled = true;
  $("action-form").querySelector('textarea[name="reason"]').disabled = true;
  try {
    const result = await api(`applications/${encodeURIComponent(review.record.id)}/${review.decision}`, {
      method: "POST",
      body: JSON.stringify({ id: review.id, reason }),
    });
    const outcome = result.outcome;
    const verifiedApproval =
      ["approve", "recheck"].includes(review.decision) &&
      result.application?.status === "approved" &&
      outcome?.state === "applied";
    const confirmedDecline =
      review.decision === "decline" && result.application?.status === "declined" && outcome?.state === "applied";
    const complete = verifiedApproval || confirmedDecline;
    $("action-title").textContent = verifiedApproval
      ? "Whitelist access confirmed"
      : confirmedDecline
        ? "Application declined"
        : "Application needs review";
    $("action-description").textContent = complete
      ? outcome.message
      : `Approval or review is not confirmed. ${outcome?.message || "Refresh this application and check Action history before repeating the request."}`;
    if (result.application) {
      review.record = result.application;
      $("action-fields").innerHTML = applicationDetails(result.application);
    }
    $("result").textContent = `${outcome?.message || "The decision requires follow-up."} Review ID: ${review.id}`;
    $("result").className = `notice ${complete ? "" : "warning"}`;
    $("result").hidden = false;
  } catch (error) {
    $("action-title").textContent = "Review result not confirmed";
    $("action-description").textContent =
      "Refresh this application and check Action history before repeating the request.";
    $("action-error").textContent = `${error.message} Review ID: ${review.id}`;
    $("action-error").hidden = false;
  } finally {
    lockTeamMove(false);
    $("submit-action").hidden = true;
    $("confirmation").innerHTML = "";
    $("action-form").querySelector('textarea[name="reason"]').parentElement.hidden = true;
    $("cancel-dialog").textContent = "Close";
    $("cancel-dialog").disabled = false;
    $("close-dialog").disabled = false;
    await refresh();
  }
}
function readFailure() {
  return state.failedPage === state.page && !state.data[state.page];
}
function render() {
  if (!state.me) return;
  if (
    state.me.role !== "admin" &&
    (state.data.applications || state.data.supporters || state.applicationReview || state.supporterReview)
  )
    clearPrivateData();
  document.querySelectorAll("[data-admin-only]").forEach((node) => {
    node.hidden = state.me.role !== "admin" || state[`${node.dataset.page}Denied`];
  });
  if (state.page === "applications" && (state.me.role !== "admin" || state.applicationsDenied)) state.page = "overview";
  if (state.page === "supporters" && (state.me.role !== "admin" || state.supportersDenied)) state.page = "overview";
  const page = state.page;
  $("page-title").textContent = titles[page][0];
  $("page-description").textContent = titles[page][1];
  $("breadcrumb").textContent = page === "overview" ? "Overview" : titles[page][0];
  document.querySelectorAll("nav [data-page]").forEach((node) => {
    node.classList.toggle("active", node.dataset.page === page);
    node.setAttribute("aria-current", node.dataset.page === page ? "page" : "false");
  });
  document.querySelector(".server-strip").hidden = ["applications", "supporters", "combat"].includes(page);
  $("connection").hidden = ["applications", "supporters", "combat"].includes(page);
  if (page === "supporters") {
    $("page").innerHTML = supporterPage();
    return;
  }
  if (page === "applications") {
    $("page").innerHTML = applicationPage();
    return;
  }
  if (page === "combat") {
    $("page").innerHTML = combatPage();
    return;
  }
  const overview = state.overview;
  if (!overview) {
    $("page").innerHTML = empty(
      "Waiting for the server",
      "Connection details will appear here when the server responds.",
    );
    return;
  }
  const { status, players } = overview;
  $("server-name").textContent = status.serverName;
  $("observed").textContent =
    `${state.stale ? "Last successful check" : "Last checked"} ${new Date(overview.observedAt).toLocaleTimeString()}`;
  $("build").textContent = overview.capabilities.build || "";
  $("connection").textContent = state.stale ? "Connection needs attention" : "● Server responding";
  $("connection").className = `pill ${state.stale ? "warn" : "good"}`;
  if (readFailure()) {
    $("page").innerHTML = empty(
      "This page could not be loaded",
      "Use Refresh to try again. No empty list has been assumed.",
    );
    return;
  }
  let html = "";
  if (page === "overview") {
    const scores = status.factionScores || [];
    const max = status.scoreCap || Math.max(1, ...scores.map((team) => team.score));
    html = `<div class="metrics">${metric("PLAYERS ONLINE", `${status.players.current}<small> / ${status.players.max}</small>`, "Current game population")}${metric("CURRENT MAP", esc(status.map), esc(status.experiences?.join(" · ") || "Live game"), true)}${metric("YOUR ACCESS", esc(state.me.role), "Verified through Discord", true)}${metric("SERVER STATUS", state.stale ? "Unavailable" : "Connected", "RCON connection", true)}</div>
      <div class="overview-grid"><div class="card"><div class="card-header"><div><h3>Current match</h3><p>${status.scoreCap ? "Faction scores" : "Scores relative to the leading faction"}</p></div>${badge("WARDOGS")}</div><div class="card-body">${scores.length ? scores.map((team) => `<div class="score-row"><div class="score-label"><span>${esc(team.name)}</span><strong>${esc(team.score.toLocaleString())}</strong></div><progress max="${max}" value="${team.score}" aria-label="${esc(team.name)} score"></progress></div>`).join("") : empty("Waiting for faction scores")}</div></div>
      <div class="card"><div class="card-header"><h3>Quick actions</h3>${badge("STAFF TOOLS")}</div><div class="card-body quick-actions"><button class="quick-action" data-action="broadcast" ${allowed("broadcast") ? "" : "disabled"}><span>Send an announcement<small>Reach everyone currently in game</small></span><span>↗</span></button><button class="quick-action" data-action="whitelist-add" ${allowed("whitelist-add") ? "" : "disabled"}><span>Add whitelist access<small>Welcome another community member</small></span><span>＋</span></button><button class="quick-action" data-page="audit"><span>Review staff activity<small>Reasons, outcomes, and accountability</small></span><span>→</span></button></div></div></div>
      <div class="card"><div class="card-header"><div><h3>On the server</h3><p>${players.length} player${players.length === 1 ? "" : "s"} in the current snapshot</p></div><button class="text-button" data-page="players">All players →</button></div>${players.length ? table(["PLAYER", "FACTION", "K / D", "PING", ""], playerRows(players.slice(0, 6), true)) : empty("The server is quiet", "Players will appear here as they join.")}</div>`;
  }
  if (page === "players") {
    const found = visiblePlayers();
    const selected = players.filter((player) => state.selectedPlayers.has(player.steamId));
    const teams = liveFactions();
    const moveReady = allowed("team") && selected.length && teams.some((team) => team.name === state.bulkFaction);
    const allShownSelected = found.length && found.every((player) => state.selectedPlayers.has(player.steamId));
    const counts = teams
      .map((team) => {
        const count = players.filter((player) => playerFaction(player)?.name === team.name).length;
        return `<div class="team-count">${factionChip(team)}<strong>${count}<span> player${count === 1 ? "" : "s"}</span></strong></div>`;
      })
      .join("");
    const unassigned = players.filter((player) => !playerFaction(player)).length;
    html =
      `<div class="team-counts">${counts}${unassigned ? `<div class="team-count"><span>Unassigned / unrecognized</span><strong>${unassigned}<span> player${unassigned === 1 ? "" : "s"}</span></strong></div>` : ""}</div>` +
      toolbar(
        "Search name, SteamID, or faction",
        '<button class="button secondary" data-unc-filter>UNC in name</button>',
      ) +
      '<p class="filter-note">“UNC in name” only searches player names. It does not verify community membership.</p>' +
      `<div class="bulk-team-bar"><label class="selection-label"><input type="checkbox" data-select-shown aria-label="Select all shown players" ${allShownSelected ? "checked" : ""} ${allowed("team") && found.length ? "" : "disabled"} />Select shown</label><span class="selection-count">${selected.length} selected${selected.length > selected.filter((player) => found.includes(player)).length ? " (includes hidden players)" : ""}</span><button class="text-button" data-clear-selection ${selected.length ? "" : "disabled"}>Clear</button><div class="bulk-team-controls"><select id="bulk-team" aria-label="Destination team for selected players" ${allowed("team") && selected.length ? "" : "disabled"}>${factionOptions(state.bulkFaction)}</select><button class="button primary" data-bulk-team ${moveReady ? "" : "disabled"}>Review move</button></div></div>` +
      teamMoveSummary() +
      `<div class="card"><div class="card-header"><h3>${found.length} player${found.length === 1 ? "" : "s"} shown</h3>${badge(state.stale ? "LAST ROSTER" : "LIVE ROSTER", state.stale ? "warn" : "good")}</div>${found.length ? table(['<span class="sr-only">Select player</span>', "PLAYER", "TEAM", "K / D", "PING", "TEAM / ACTIONS"], playerRows(found)) : empty("No matching players", "Try a different search or refresh the roster.")}</div>`;
  }
  if (page === "whitelist") {
    const data = state.data.whitelist;
    if (!data) html = empty("Loading whitelist…");
    else {
      const rows = filter(data.entries, ["steamId"]);
      html = `<div class="notice info"><strong>Current community access stays in place.</strong> Existing whitelist entries have no new expiry. Membership billing, seeding rewards, and future queue tiers are not changing this list.</div>`;
      if (!data.configurationAvailable)
        html += `<div class="notice warning">The running whitelist is available, but the saved configuration could not be checked.</div>`;
      html +=
        toolbar("Search SteamID64", button("whitelist-add", "+ Add player", "", "primary")) +
        `<div class="card"><div class="card-header"><h3>${data.entries.filter((e) => e.active).length} active entries</h3>${badge("SERVER WHITELIST")}</div>${
          rows.length
            ? table(
                ["STEAMID64", "RUNNING GAME", "SAVED CONFIGURATION", ""],
                rows.map(
                  (entry) =>
                    `<tr><td><strong>${esc(entry.steamId)}</strong></td><td>${badge(entry.active ? "Active" : "Not active", entry.active ? "good" : "warn")}</td><td>${badge(entry.configured === null ? "Unavailable" : entry.configured ? (entry.active ? "Saved" : "Addition pending") : entry.active ? "Removal pending" : "Removed", entry.configured === entry.active ? "neutral" : "warn")}</td><td><div class="row-actions">${button("whitelist-remove", "Remove", entry.steamId, "danger small")}</div></td></tr>`,
                ),
              )
            : empty("No matching entries")
        }</div>`;
    }
  }
  if (page === "bans") {
    const bans = state.data.bans;
    if (!bans) html = empty("Loading bans…");
    else {
      const rows = filter(bans, ["steamId", "reason", "bannedBy"]);
      html =
        toolbar("Search SteamID or reason", button("ban", "+ Ban player", "", "danger")) +
        `<div class="card"><div class="card-header"><h3>${bans.length} server bans</h3>${badge("PERMANENT UNTIL REMOVED")}</div>${
          rows.length
            ? table(
                ["PLAYER", "REASON", "BANNED BY", ""],
                rows.map(
                  (ban) =>
                    `<tr><td><strong>${esc(ban.steamId)}</strong><small>${ban.bannedAtUtc && !ban.bannedAtUtc.startsWith("0001") ? esc(new Date(ban.bannedAtUtc).toLocaleDateString()) : "Date not provided"}</small></td><td class="audit-detail">${esc(ban.reason || "No reason supplied by the game")}</td><td>${esc(ban.bannedBy || "—")}</td><td>${button("unban", "Remove ban", ban.steamId)}</td></tr>`,
                ),
              )
            : empty("No matching bans")
        }</div>`;
    }
  }
  if (page === "announcements") {
    html = `<div class="split"><div class="card"><div class="card-header"><h3>In-game broadcast</h3>${badge("SEND NOW", "good")}</div><div class="card-body"><p class="intro">An announcement for everyone currently connected. Use it for server notices, community events, or a quick thank-you.</p><div class="copy-example">GG! Thanks for playing on The UNCs. Squad up with our adult gaming community at discord.gg/t5NSzurtRS.</div>${button("broadcast", "Write announcement ↗", "", "primary")}</div></div><div class="card"><div class="card-header"><h3>Automatic community messages</h3>${badge("NOT CONNECTED")}</div><div class="card-body"><p class="intro">Join welcomes, automatic end-of-match messages, and the Discord live-status card still need their Gramps automation connection. This page does not change the bot already sending welcome messages.</p><div class="info-row"><span>Join welcome</span><strong>Existing bot</strong></div><div class="info-row"><span>End-of-match automation</span><strong>Pending integration</strong></div><div class="info-row"><span>Discord status card</span><strong>Pending integration</strong></div></div></div></div>`;
  }
  if (page === "match") {
    const rotation = state.data.rotation;
    html = `<div class="split"><div class="card"><div class="card-header"><h3>Current match</h3>${badge(status.map)}</div><div class="card-body"><div class="info-row"><span>Map</span><strong>${esc(status.map)}</strong></div><div class="info-row"><span>Lighting</span><strong>${esc(status.lighting || "Not supplied")}</strong></div><div class="info-row"><span>Experience</span><strong>${esc(status.experiences?.join(", ") || "Not supplied")}</strong></div><p class="intro">Map and match actions affect everyone in the game. Confirm the exact action before sending it to the server.</p><div class="action-list">${button("map", "Change map")}${button("lighting", "Set lighting")}${button("match-end", "End match", "", "danger small")}${button("match-restart", "Restart match", "", "danger small")}</div></div></div><div class="card"><div class="card-header"><h3>Map rotation</h3>${badge(rotation ? rotation.mode : "UNAVAILABLE")}</div>${
      rotation
        ? table(
            ["MAP", "LIGHTING", "STATUS"],
            rotation.entries.map(
              (entry) =>
                `<tr><td>${esc(entry.map)}</td><td>${esc(entry.lighting || "—")}</td><td>${badge(entry.denied ? "Unavailable" : entry.status || "Queued", entry.status === "now" ? "good" : "neutral")}</td></tr>`,
            ),
          )
        : empty("Rotation is unavailable", "The current game build may not expose it.")
    }</div></div><div class="notice info">Server process restarts, host scheduling, and configuration outside the game remain in the hosting panel. “Restart match” only reloads the current round.</div>`;
  }
  if (page === "audit") {
    const audit = state.data.audit;
    if (!audit) html = empty("Loading action history…");
    else {
      const rows = filter(audit, ["actorName", "action", "target", "message"]);
      html =
        toolbar("Search staff, action, or SteamID") +
        `<div class="card"><div class="card-header"><h3>Recent staff actions</h3>${badge("LAST 100")}</div>${
          rows.length
            ? table(
                ["WHEN / STAFF", "ACTION / TARGET", "OUTCOME", "DETAILS"],
                rows.map(
                  (entry) =>
                    `<tr><td><strong>${esc(entry.actorName)}</strong><small>${esc(new Date(entry.createdAt).toLocaleString())}</small></td><td>${esc(actions[entry.action]?.[0] || entry.action)}<small>${esc(entry.target)}</small></td><td>${badge(entry.state === "started" ? "Unconfirmed" : entry.state, entry.state === "applied" ? "good" : ["unknown", "pending", "started"].includes(entry.state) ? "warn" : entry.state === "failed" ? "bad" : "neutral")}</td><td class="audit-detail"><strong>${esc(entry.details.reason)}</strong><br />${esc(entry.message)}<small>${esc(entry.id)}</small></td></tr>`,
                ),
              )
            : empty(
                "No matching staff actions",
                "Actions performed through this dashboard appear here. Older activity from other tools is not imported.",
              )
        }</div>`;
    }
  }
  $("page").innerHTML = html;
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api/${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json", "X-CSRF-Token": state.me?.csrf || "" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      state.me = null;
      showLogin(data.message);
    }
    if (response.status === 403) {
      clearPrivateData();
      state.applicationsDenied = true;
      state.supportersDenied = true;
      state.stale = true;
      render();
    }
    const error = new Error(data.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function clearPrivateData() {
  state.privateEpoch++;
  delete state.data.applications;
  delete state.data.supporters;
  if (
    state.applicationReview ||
    state.supporterReview ||
    $("action-dialog").classList.contains("application-dialog") ||
    $("action-dialog").classList.contains("supporter-dialog")
  ) {
    state.applicationReview = null;
    state.supporterReview = null;
    $("action-dialog").close();
    $("action-fields").innerHTML = "";
    $("action-title").textContent = "";
    $("action-description").textContent = "";
    $("action-error").textContent = "";
    $("confirmation").innerHTML = "";
    $("action-form").reset();
  }
  $("result").textContent = "";
  $("result").hidden = true;
  if (["applications", "supporters"].includes(state.page)) $("page").innerHTML = "";
}
function showLogin(message) {
  clearPrivateData();
  $("shell").hidden = true;
  $("login").hidden = false;
  $("login-note").textContent = message || "Use a Discord account with an assigned staff role.";
}
async function refresh() {
  if (state.loading || state.busy || !state.me) return;
  state.loading = true;
  $("refresh").disabled = true;
  const page = state.page;
  const principal = state.me;
  const privateEpoch = state.privateEpoch;
  const combatKey = combatViewKey();
  try {
    if (["applications", "supporters"].includes(page) && state.me.role === "admin") {
      const result = await api(page);
      if (state.me !== principal || privateEpoch !== state.privateEpoch || state.me?.role !== "admin") return;
      state.data[page] = result;
    } else if (page === "combat") {
      const path = state.combatPlayer ? `combat/players/${encodeURIComponent(state.combatPlayer)}` : "combat";
      const result = await api(`${path}?period=${state.combatPeriod}`);
      state.data.combat = { ...result, _viewKey: combatKey };
    } else {
      state.overview = await api("overview");
      state.stale = false;
      if (["whitelist", "bans", "audit"].includes(page)) state.data[page] = await api(page);
      if (page === "match") {
        state.data.catalog = await api("catalog");
        state.data.rotation = await api("rotation").catch(() => null);
      }
    }
    state.failedPage = null;
    $("error").hidden = true;
  } catch (error) {
    state.stale = true;
    state.failedPage = page;
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
    const focused = document.activeElement?.id === "search";
    const cursor = focused ? $("search").selectionStart : null;
    render();
    if (focused && $("search")) {
      $("search").focus();
      try {
        $("search").setSelectionRange(cursor, cursor);
      } catch {
        /* Some browsers do not expose a search selection. */
      }
    }
    if (page !== state.page || (page === "combat" && combatKey !== combatViewKey())) void refresh();
  }
}
function selectOptions(items, selected = "") {
  return items
    .map(
      (item) =>
        `<option value="${esc(item.id)}" ${selected === item.id ? "selected" : ""}>${esc(item.displayName || item.id)}</option>`,
    )
    .join("");
}
function teamOutcome(item) {
  const labels = {
    queued: "Not sent",
    sending: "Sending…",
    applied: "Assignment confirmed",
    accepted: "Accepted · not verified",
    pending: "Pending",
    failed: "Failed",
    unknown: "Unconfirmed",
    skipped: "Already on team",
  };
  return badge(
    labels[item.state] || "Unconfirmed",
    item.state === "applied"
      ? "good"
      : item.state === "failed"
        ? "bad"
        : ["unknown", "pending", "sending"].includes(item.state)
          ? "warn"
          : "neutral",
  );
}
function teamMoveRows(move) {
  return move.items.map(
    (item) =>
      `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.steamId)}</small></td><td>${teamOutcome(item)}</td><td class="audit-detail">${esc(item.message || "Not sent")}${item.state !== "queued" && item.state !== "skipped" ? `<small>Action ${esc(item.id)}</small>` : ""}</td></tr>`,
  );
}
function teamMoveSummary() {
  const move = state.lastTeamMove;
  if (!move) return "";
  return `<details class="team-results" ${move.stopped ? "open" : ""}><summary>Last team move · ${esc(move.label)} · ${move.items.filter((item) => ["applied", "accepted", "pending"].includes(item.state)).length} acknowledged${move.stopped ? " · stopped early" : ""}</summary><p class="muted">Accepted means the game received the request. Assignment confirmation does not force a respawn. Unsent players stay selected for a new review.</p>${table(["PLAYER", "OUTCOME", "DETAILS"], teamMoveRows(move))}</details>`;
}
function teamReviewItems(move) {
  return `<ul class="team-review-players">${move.items.map((item) => `<li><div><strong>${esc(item.name)}</strong><small>${esc(item.steamId)}</small></div><span>${esc(item.fromLabel || "Choosing team")} → <strong>${esc(move.label || "Choose destination")}</strong>${item.from === move.faction ? "<small>Already on this team — no request will be sent</small>" : ""}</span></li>`).join("")}</ul>`;
}
function renderTeamDialog() {
  const move = state.teamMove;
  if (!move) return;
  const pending = move.items.filter((item) => item.state === "queued").length;
  const count = move.items.filter((item) => item.from !== move.faction).length;
  $("action-title").textContent = move.submitted
    ? move.running
      ? "Moving players"
      : move.stopped
        ? "Team move stopped"
        : "Team requests complete"
    : `Move ${move.items.length === 1 ? move.items[0].name : `${move.items.length} players`}`;
  $("action-description").textContent = move.submitted
    ? `${move.label}. Each player has their own recorded outcome. ${pending} not sent.`
    : "Review the named players and destination. This changes team assignment without sending a forced kill; players may need to respawn.";
  $("action-fields").innerHTML = move.submitted
    ? `<div class="team-progress" role="status">${move.items.filter((item) => item.state !== "queued" && item.state !== "sending").length} / ${move.items.length} processed${move.running ? " · sending one at a time" : ""}</div>${table(["PLAYER", "OUTCOME", "DETAILS"], teamMoveRows(move))}`
    : `<label>Destination team<select id="review-team" name="faction" required>${factionOptions(move.faction, move.items.length === 1 ? move.items[0].from : "")}</select></label>${teamReviewItems(move)}`;
  $("confirmation").innerHTML = "";
  const reason = $("action-form").querySelector('textarea[name="reason"]');
  reason.parentElement.hidden = move.submitted;
  reason.disabled = move.submitted;
  $("submit-action").hidden = move.submitted;
  $("submit-action").disabled = move.submitted || !move.faction || !count;
  $("submit-action").textContent =
    `Move ${count} player${count === 1 ? "" : "s"}${move.label ? ` to ${move.label}` : ""}`;
  $("cancel-dialog").textContent = move.submitted ? "Close" : "Cancel";
  $("cancel-dialog").disabled = move.running;
  $("close-dialog").disabled = move.running;
}
function openTeamMove(ids, faction = "") {
  if (!allowed("team") || state.loading) return;
  const roster = state.overview.players;
  const players = [...new Set(ids)].map((id) => roster.find((player) => player.steamId === id)).filter(Boolean);
  if (!players.length) return;
  const destination = liveFactions().find((team) => team.name === faction);
  state.applicationReview = null;
  state.supporterReview = null;
  state.action = null;
  state.teamMove = {
    faction: destination?.name || "",
    label: destination?.label || "",
    submitted: false,
    running: false,
    stopped: false,
    items: players.map((player) => ({
      name: player.name,
      steamId: player.steamId,
      from: playerFaction(player)?.name || "",
      fromLabel: playerFaction(player)?.label || player.faction || "",
      id: crypto.randomUUID(),
      state: "queued",
      message: "Not sent",
    })),
  };
  $("action-form").reset();
  const reason = $("action-form").querySelector('textarea[name="reason"]');
  reason.disabled = false;
  reason.value = "Staff-assisted team move to group players together.";
  $("action-error").hidden = true;
  $("action-dialog").classList.remove("application-dialog", "supporter-dialog");
  $("action-dialog").classList.add("team-dialog");
  document.querySelector(".dialog-top .eyebrow").textContent = "TEAM MOVE";
  renderTeamDialog();
  if (!$("action-dialog").open) $("action-dialog").showModal();
}
function lockTeamMove(locked) {
  state.busy = locked;
  document.querySelectorAll("nav [data-page], [data-logout], #refresh").forEach((node) => {
    node.disabled = locked;
  });
}
async function submitTeamMove(reason) {
  const move = state.teamMove;
  if (!move || move.submitted || state.busy || state.loading || !allowed("team")) return;
  const destination = liveFactions().find((team) => team.name === move.faction);
  if (!destination || !move.items.some((item) => item.from !== destination.name)) return;
  move.submitted = true;
  move.running = true;
  move.reason = reason;
  lockTeamMove(true);
  $("action-error").hidden = true;
  let sent = false;
  try {
    for (const item of move.items) {
      if (item.from === move.faction) {
        item.state = "skipped";
        item.message = "Already on the chosen team in the reviewed roster. No request sent.";
        state.selectedPlayers.delete(item.steamId);
        continue;
      }
      // The dashboard allows 30 mutations per minute. Keep individual requests
      // separate and leave headroom; rate limits still stop this batch.
      if (sent) await new Promise((resolve) => setTimeout(resolve, 2200));
      item.state = "sending";
      item.message = "Waiting for the game’s response.";
      renderTeamDialog();
      sent = true;
      try {
        const result = await api("actions", {
          method: "POST",
          body: JSON.stringify({
            id: item.id,
            action: "team",
            steamId: item.steamId,
            confirm: item.steamId,
            faction: move.faction,
            reason: move.reason,
          }),
        });
        item.state = ["applied", "accepted", "pending", "failed", "unknown"].includes(result.state)
          ? result.state
          : "unknown";
        item.message = result.message || "The outcome could not be confirmed. Check Action history before repeating.";
      } catch (error) {
        // A gateway/server timeout may arrive after the game acted. Only
        // definite request rejections can be labelled failed.
        item.state = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(error.status) ? "failed" : "unknown";
        item.message = `${error.message} Check this action in Action history before repeating it.`;
      }
      // An attempted item is never automatically included in another batch.
      // Unprocessed items remain selected for a fresh, explicit review.
      state.selectedPlayers.delete(item.steamId);
      delete state.teamDestinations[item.steamId];
      if (["failed", "unknown"].includes(item.state)) {
        move.stopped = true;
        state.stale = true;
        break;
      }
    }
  } finally {
    move.running = false;
    state.lastTeamMove = move;
    lockTeamMove(false);
    renderTeamDialog();
    render();
    if (move.stopped) {
      $("action-error").textContent =
        "Stopped after the first failed or unconfirmed result. No remaining requests were sent. Review the outcome and refresh the roster before moving the remaining selected players.";
      $("action-error").hidden = false;
    } else {
      await refresh();
    }
  }
}
async function openAction(action, id = "") {
  if (!allowed(action)) return;
  if (action === "team") {
    openTeamMove([id]);
    return;
  }
  state.teamMove = null;
  state.applicationReview = null;
  state.supporterReview = null;
  $("action-dialog").classList.remove("application-dialog", "supporter-dialog");
  $("action-dialog").classList.remove("team-dialog");
  document.querySelector(".dialog-top .eyebrow").textContent = "SERVER ACTION";
  if (["map", "lighting"].includes(action) && !state.data.catalog) {
    try {
      state.data.catalog = await api("catalog");
    } catch (error) {
      $("error").textContent = error.message;
      $("error").hidden = false;
      return;
    }
  }
  const player = state.overview.players.find((entry) => entry.steamId === id);
  state.action = { action, id: crypto.randomUUID(), steamId: id };
  $("action-form").reset();
  $("action-form").querySelector('textarea[name="reason"]').disabled = false;
  $("cancel-dialog").textContent = "Cancel";
  $("action-title").textContent = actions[action][0];
  $("action-description").textContent = actions[action][1];
  $("submit-action").textContent = "Confirm action";
  $("submit-action").disabled = false;
  $("action-error").hidden = true;
  let fields = "";
  if (["kick", "ban", "unban", "whitelist-add", "whitelist-remove", "message", "kill", "team"].includes(action)) {
    fields += id
      ? `<div class="target-box">${esc(player?.name || "Selected player")}<small>${esc(id)}</small></div>`
      : '<label>SteamID64<input name="steamId" required pattern="7656119[0-9]{10}" maxlength="17" placeholder="7656119…" inputmode="numeric" /></label>';
  }
  if (["message", "broadcast"].includes(action))
    fields +=
      '<label>In-game message <span class="muted">(up to 200 characters)</span><textarea name="message" maxlength="200" required rows="4" placeholder="Write your message…"></textarea></label>';
  if (action === "map")
    fields += `<label>Map<select name="map" required>${selectOptions(state.data.catalog.maps, state.overview.status.map)}</select></label><label>Experiences <span class="muted">(optional; Ctrl / Cmd to select several)</span><select name="experiences" multiple>${selectOptions(state.data.catalog.experiences)}</select></label>`;
  if (["map", "lighting"].includes(action))
    fields += `<label>Lighting<select name="lighting" ${action === "lighting" ? "required" : ""}>${action === "map" ? '<option value="">Game default</option>' : ""}${selectOptions(state.data.catalog.lightings)}</select></label>`;
  $("action-fields").innerHTML = fields;
  const phrase = { "match-end": "END MATCH", "match-restart": "RESTART MATCH", map: "CHANGE MAP" }[action];
  $("confirmation").innerHTML = destructive.includes(action)
    ? `<label>Type ${phrase ? `<strong>${phrase}</strong>` : "the player's SteamID64"} to confirm<input name="confirm" required autocomplete="off" placeholder="${esc(phrase || id || "SteamID64")}" /></label>`
    : "";
  if (!$("action-dialog").open) $("action-dialog").showModal();
}
function managePlayer(id) {
  const player = state.overview.players.find((entry) => entry.steamId === id);
  if (!player || state.busy || state.stale || state.me.role === "viewer") return;
  state.teamMove = null;
  state.applicationReview = null;
  state.supporterReview = null;
  $("action-dialog").classList.remove("application-dialog", "supporter-dialog");
  $("action-dialog").classList.remove("team-dialog");
  document.querySelector(".dialog-top .eyebrow").textContent = "SERVER ACTION";
  state.action = null;
  $("action-title").textContent = player.name;
  $("action-description").textContent = id;
  $("action-form").reset();
  $("action-form").querySelector('textarea[name="reason"]').disabled = false;
  $("cancel-dialog").textContent = "Cancel";
  $("action-error").hidden = true;
  $("confirmation").innerHTML = "";
  $("action-fields").innerHTML =
    `<div class="action-list">${["message", "kick", "ban", "whitelist-add", "team", "kill"].map((action) => button(action, actions[action][0], id)).join("")}</div>`;
  $("action-form").querySelector('textarea[name="reason"]').parentElement.hidden = true;
  $("submit-action").hidden = true;
  $("action-dialog").showModal();
}
document.addEventListener("click", (event) => {
  if (state.busy) {
    event.preventDefault();
    return;
  }
  const combatPeriod = event.target.closest("[data-combat-period]");
  if (combatPeriod && Object.hasOwn(combatPeriods, combatPeriod.dataset.combatPeriod)) {
    state.combatPeriod = combatPeriod.dataset.combatPeriod;
    state.combatWeapon = "";
    state.query = "";
    render();
    void refresh();
    return;
  }
  const combatPlayer = event.target.closest("[data-combat-player]");
  if (combatPlayer && /^7656119\d{10}$/.test(combatPlayer.dataset.combatPlayer)) {
    state.page = "combat";
    state.combatPlayer = combatPlayer.dataset.combatPlayer;
    state.combatWeapon = "";
    state.combatEventKind = "all";
    state.query = "";
    render();
    void refresh();
    return;
  }
  if (event.target.closest("[data-combat-back]")) {
    state.combatPlayer = "";
    state.combatWeapon = "";
    state.combatEventKind = "all";
    state.query = "";
    render();
    void refresh();
    return;
  }
  const supporter = event.target.closest("[data-supporter]");
  if (supporter && !supporter.disabled) {
    openSupporter(supporter.dataset.supporter);
    return;
  }
  const supporterDecision = event.target.closest("[data-supporter-decision]");
  if (supporterDecision && !supporterDecision.disabled) {
    openSupporter(supporterDecision.dataset.supporterId, supporterDecision.dataset.supporterDecision);
    return;
  }
  const application = event.target.closest("[data-application]");
  if (application && !application.disabled) {
    openApplication(application.dataset.application);
    return;
  }
  const decision = event.target.closest("[data-application-decision]");
  if (decision && !decision.disabled) {
    openApplication(decision.dataset.applicationId, decision.dataset.applicationDecision);
    return;
  }
  const move = event.target.closest("[data-team-move]");
  if (move && !move.disabled) {
    openTeamMove([move.dataset.teamMove], state.teamDestinations[move.dataset.teamMove]);
    return;
  }
  const bulk = event.target.closest("[data-bulk-team]");
  if (bulk && !bulk.disabled) {
    openTeamMove([...state.selectedPlayers], state.bulkFaction);
    return;
  }
  if (event.target.closest("[data-clear-selection]")) {
    state.selectedPlayers.clear();
    render();
    return;
  }
  if (event.target.closest("[data-unc-filter]")) {
    state.query = "UNC";
    state.nameOnly = true;
    render();
    return;
  }
  const page = event.target.closest("[data-page]");
  if (page) {
    state.page = page.dataset.page;
    state.query = "";
    state.nameOnly = false;
    render();
    void refresh();
  }
  const action = event.target.closest("[data-action]");
  if (action && !action.disabled) {
    $("action-form").querySelector('textarea[name="reason"]').parentElement.hidden = false;
    $("submit-action").hidden = false;
    void openAction(action.dataset.action, action.dataset.id || "");
  }
  const manage = event.target.closest("[data-manage]");
  if (manage && !manage.disabled) managePlayer(manage.dataset.manage);
});
document.addEventListener("input", (event) => {
  if (state.busy || event.target.id !== "search") return;
  const cursor = event.target.selectionStart;
  state.query = event.target.value;
  state.nameOnly = false;
  render();
  $("search").focus();
  try {
    $("search").setSelectionRange(cursor, cursor);
  } catch {
    /* Search input selection is optional. */
  }
});
document.addEventListener("change", (event) => {
  if (state.busy) return;
  const target = event.target;
  if (target.id === "combat-event-kind") {
    state.combatEventKind = target.value === "headshot" ? "headshot" : "all";
    render();
  }
  if (target.id === "combat-weapon") {
    state.combatWeapon = target.value;
    render();
  }
  if (target.matches("[data-select-player]")) {
    if (target.checked) state.selectedPlayers.add(target.dataset.selectPlayer);
    else state.selectedPlayers.delete(target.dataset.selectPlayer);
    render();
  }
  if (target.matches("[data-select-shown]")) {
    for (const player of visiblePlayers()) {
      if (target.checked) state.selectedPlayers.add(player.steamId);
      else state.selectedPlayers.delete(player.steamId);
    }
    render();
  }
  if (target.matches("[data-team-destination]")) {
    state.teamDestinations[target.dataset.teamDestination] = target.value;
    render();
  }
  if (target.id === "bulk-team") {
    state.bulkFaction = target.value;
    render();
  }
  if (target.id === "review-team" && state.teamMove && !state.teamMove.submitted) {
    const faction = liveFactions().find((team) => team.name === target.value);
    state.teamMove.faction = faction?.name || "";
    state.teamMove.label = faction?.label || "";
    renderTeamDialog();
  }
});
function closeDialog() {
  if (!state.busy) {
    $("action-dialog").close();
    state.teamMove = null;
    state.applicationReview = null;
    state.supporterReview = null;
  }
}
$("close-dialog").addEventListener("click", closeDialog);
$("cancel-dialog").addEventListener("click", closeDialog);
$("action-dialog").addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});
$("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  if (state.supporterReview) {
    await submitSupporterReview(new FormData(event.target));
    return;
  }
  if (state.applicationReview) {
    await submitApplicationReview(new FormData(event.target).get("reason"));
    return;
  }
  if (state.teamMove) {
    await submitTeamMove(new FormData(event.target).get("reason"));
    return;
  }
  if (!state.action) return;
  const values = new FormData(event.target),
    input = { id: state.action.id, action: state.action.action, reason: values.get("reason") };
  if (state.action.steamId || values.get("steamId")) input.steamId = state.action.steamId || values.get("steamId");
  for (const key of ["message", "confirm", "map", "lighting", "faction"])
    if (values.get(key)) input[key] = values.get(key);
  if (values.getAll("experiences").length) input.experiences = values.getAll("experiences");
  state.busy = true;
  $("submit-action").disabled = true;
  $("submit-action").textContent = "Sending…";
  $("action-error").hidden = true;
  try {
    const result = await api("actions", { method: "POST", body: JSON.stringify(input) });
    $("action-dialog").close();
    $("result").textContent = `${result.message} Action ID: ${result.id}`;
    $("result").className =
      `notice ${["unknown", "pending"].includes(result.state) ? "warning" : result.state === "failed" ? "error" : ""}`;
    $("result").hidden = false;
    await refresh();
  } catch (error) {
    $("action-error").textContent =
      `${error.message} If the connection dropped after sending, check Action history before repeating the action. ID: ${input.id}`;
    $("action-error").hidden = false;
    // Retain the request ID. A repeat of the exact request cannot execute twice.
    $("submit-action").textContent = "Check / resubmit same action";
    $("submit-action").disabled = false;
  } finally {
    state.busy = false;
    await refresh();
  }
});
$("refresh").addEventListener("click", () => void refresh());
document.querySelectorAll("[data-logout]").forEach((button) =>
  button.addEventListener("click", async () => {
    if (state.busy) return;
    try {
      await api("logout", { method: "POST", body: "{}" });
      state.me = null;
      showLogin("Signed out.");
    } catch (error) {
      $("error").textContent = error.message;
      $("error").hidden = false;
    }
  }),
);
async function poll() {
  if (!document.hidden && state.me && !state.busy && !$("action-dialog").open) await refresh();
  setTimeout(poll, 20_000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("action-dialog").open) void refresh();
});
window.addEventListener("beforeunload", (event) => {
  if (state.teamMove?.running) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function start() {
  try {
    state.me = await api("me");
    state.applicationsDenied = false;
    state.supportersDenied = false;
    $("staff-name").textContent = state.me.name;
    $("staff-role").textContent = state.me.role;
    $("avatar").textContent = state.me.name.slice(0, 1).toUpperCase();
    $("demo-banner").hidden = !state.me.demo;
    $("shell").hidden = false;
    $("login").hidden = true;
    await refresh();
    setTimeout(poll, 20_000);
  } catch (error) {
    showLogin(error.message);
  }
}
void start();
