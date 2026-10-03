import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { DiscordRolesPage } from "./index";
import { adds, dryRun, ledgerRow, members, notes, pass, removal, rolesStatus } from "./test-fixtures";
import type { DiscordRolesStatus, ReconcileResponse } from "./types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const context: AdminContextValue = {
  me: { id: "12345678901234567", name: "Admin", role: "admin", csrf: "fixture" },
  overview: null,
  stale: true,
  busy: false,
  dialogOpen: false,
  refreshVersion: 0,
  setBusy: vi.fn(),
  setDialogOpen: vi.fn(),
  setUnsavedChanges: vi.fn(),
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  openAction: vi.fn(),
};
function page(value = context) {
  return (
    <AdminContext.Provider value={value}>
      <DiscordRolesPage />
    </AdminContext.Provider>
  );
}
/** An error as the dashboard's api helper throws it: the server's message with the HTTP status. */
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
type Reconcile = (body: Record<string, unknown>) => Promise<ReconcileResponse> | ReconcileResponse;
function serve(status: DiscordRolesStatus | (() => DiscordRolesStatus), reconcile?: Reconcile) {
  request.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === "discord-roles") return structuredClone(typeof status === "function" ? status() : status);
    if (path === "discord-roles/reconcile" && reconcile) return reconcile(JSON.parse(String(options?.body)));
    throw new Error(`Unexpected request ${path}`);
  });
}
const posts = () =>
  request.mock.calls
    .filter(([, options]) => options?.method === "POST")
    .map(([path, options]) => ({ path, body: JSON.parse(String(options?.body)) as Record<string, unknown> }));
const reads = () => request.mock.calls.filter(([path]) => path === "discord-roles").length;
const statusLine = () => document.querySelector(".status-line");
const runButton = () => screen.getByRole("button", { name: "Run role check now" });
const previewButton = () => screen.getByRole("button", { name: "Preview changes" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Runs a preview from its button and waits for the plan. */
async function preview() {
  fireEvent.click(await screen.findByRole("button", { name: "Preview changes" }));
  await screen.findByRole("region", { name: "Preview of role changes" });
  expect(posts().at(-1)?.body).toMatchObject({ dryRun: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

it("never reads the roles status for staff below administrator", () => {
  render(page({ ...context, me: { ...context.me, role: "moderator" } }));
  expect(screen.getByText("Administrator access required")).toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

describe("feature state", () => {
  it.each<[string, Partial<DiscordRolesStatus>, string]>([
    ["Off", { ready: false }, "Automatic Discord roles: Off"],
    ["Ready to switch on", {}, "Automatic Discord roles: Ready to switch on"],
    ["On", { enabled: true }, "Automatic Discord roles: On"],
  ])("shows %s with Discord's connection", async (_state, overrides, line) => {
    serve(rolesStatus(overrides));
    render(page());
    await waitFor(() => expect(statusLine()).toHaveTextContent(line));
    expect(statusLine()).toHaveTextContent("Discord connected");
    // Opening the page only reads the status.
    expect(posts()).toHaveLength(0);
  });

  it("says when Discord is not connected and a check is running or queued", async () => {
    serve(
      rolesStatus({
        enabled: true,
        ready: false,
        discordReady: false,
        running: true,
        queued: 3,
        fullPassQueued: true,
        bot: { manageRoles: null, highestRolePosition: null },
      }),
    );
    render(page());
    await waitFor(() => expect(statusLine()).toHaveTextContent("Automatic Discord roles: On"));
    expect(statusLine()).toHaveTextContent("Discord not connected");
    expect(statusLine()).toHaveTextContent("A role check is running now");
    expect(statusLine()).toHaveTextContent("3 people waiting for a check");
    expect(screen.getByText(/a role fails its setup checks below/)).toBeInTheDocument();
    expect(screen.getByText("Discord is not connected yet, so Gramps can’t read the roles.")).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/Discord is not connected yet/);
  });
});

it("lists each setup check with its fix, the Supporter candidates and the bot's permission", async () => {
  const status = rolesStatus();
  status.roles.founder = {
    ...status.roles.founder,
    assignable: false,
    problem: 'Drag the bot\'s role above "Founder" in Server Settings, Roles.',
  };
  serve({ ...status, ready: false, bot: { manageRoles: false, highestRolePosition: 8 } });
  render(page());
  const rows = [...(await screen.findByRole("list", { name: "Setup checks" })).children] as HTMLElement[];
  const row = (title: string) => rows.find((item) => item.querySelector("strong")?.textContent === title)!;
  expect(within(row("UNC role")).getByText("Ready")).toBeInTheDocument();
  expect(row("UNC role")).toHaveTextContent("Discord role “UNC”");
  expect(within(row("UNC role")).getByRole("button", { name: "Copy UNC role ID 600000000000000001" })).toBeVisible();
  expect(row("Founder role")).toHaveTextContent('Fix: Drag the bot\'s role above "Founder"');
  expect(within(row("Founder role")).getByText("Needs a fix")).toBeInTheDocument();
  const supporter = row("Supporter role (optional)");
  expect(within(supporter).getByText("Optional · not set up")).toBeInTheDocument();
  expect(supporter).toHaveTextContent("Gramps skips the Supporter role entirely");
  expect(supporter).toHaveTextContent("To add it: Set DISCORD_SUPPORTER_ROLE_ID");
  expect(within(supporter).getByRole("list", { name: "Roles named Supporter" })).toHaveTextContent("Supporter");
  expect(within(supporter).getByRole("button", { name: "Copy Supporter role ID 600000000000000003" })).toBeVisible();
  expect(row("Bot can manage roles")).toHaveTextContent("Fix: Give the bot’s role the Manage Roles permission");
  expect(row("Bot can manage roles")).toHaveTextContent("position 8");
});

it("shows the counts, the last checks, the attention list and the latest 25 ledger rows", async () => {
  serve(
    rolesStatus({
      summary: { memberEligible: 42, founders: 6, foundersWithoutDiscord: 2, supporterEligible: 5 },
      lastPass: pass({ trigger: "event", added: 1, removed: 0, noted: 0, failed: 0, deferred: 0, users: 1 }),
      lastFullPass: pass({ error: "Setup: No role can be assigned. Fix the role setup on the Discord roles page." }),
      recent: Array.from({ length: 30 }, (_, index) => ledgerRow(index + 1)),
    }),
  );
  render(page());
  const counts = within(await screen.findByLabelText("Role counts"));
  expect(counts.getByText("UNC eligible").nextElementSibling).toHaveTextContent("42");
  expect(counts.getByText("Founders without Discord").nextElementSibling).toHaveTextContent("2");
  expect(counts.getByText("Supporters now").nextElementSibling).toHaveTextContent("5");
  const last = within(screen.getByRole("region", { name: "Last check" }));
  expect(last.getByText("After a change", { exact: false })).toBeInTheDocument();
  expect(last.getByText("Added").nextElementSibling).toHaveTextContent("1");
  const full = within(screen.getByRole("region", { name: "Last full check" }));
  expect(full.getByText(/Setup: No role can be assigned/)).toBeInTheDocument();
  for (const label of ["Added", "Removed", "Noted", "Failed", "Blocked", "Deferred"])
    expect(full.getByText(label)).toBeInTheDocument();
  expect(full.getByText("Deferred").nextElementSibling).toHaveTextContent("4");
  const attention = within(screen.getByRole("list", { name: "Needs attention" }));
  expect(attention.getByText("Grandpa Joe")).toBeInTheDocument();
  expect(attention.getByText("PayPal")).toBeInTheDocument();
  expect(attention.getByText(/Link their Discord account on the Supporters page/)).toBeInTheDocument();
  expect(attention.getByRole("button", { name: `Copy Discord user ID ${members.away}` })).toBeVisible();
  expect(attention.getByText(/Not in the Discord server/)).toBeInTheDocument();
  expect(attention.getByText(/A UNC role change failed/)).toBeInTheDocument();
  const ledger = within(screen.getByRole("table", { name: "Recent role changes" }));
  expect(ledger.getAllByRole("row")).toHaveLength(26);
  expect(ledger.getByRole("button", { name: `Copy Discord user ID ${ledgerRow(1).discordUserId}` })).toBeVisible();
  expect(ledger.queryByText(ledgerRow(26).discordUserId)).not.toBeInTheDocument();
});

describe("preview", () => {
  it("sends a dry run and groups the plan as Add and Remove, highlighting the removal", async () => {
    serve(rolesStatus(), () => dryRun([...adds, removal, ...notes]));
    render(page());
    await preview();
    const [post] = posts();
    expect(post.path).toBe("discord-roles/reconcile");
    expect(post.body).toEqual({ id: expect.stringMatching(uuid), reason: "Preview from the dashboard", dryRun: true });
    const shown = within(screen.getByRole("region", { name: "Preview of role changes" }));
    expect(shown.getByText("Add", { selector: "dt" }).nextElementSibling).toHaveTextContent("2");
    expect(shown.getByText("Remove", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    const added = within(shown.getByRole("list", { name: "Add" }));
    expect(added.getAllByRole("listitem")).toHaveLength(2);
    expect(added.getByText("Approved UNC member application")).toBeInTheDocument();
    expect(added.getByText("Founder record with a linked Discord account")).toBeInTheDocument();
    const removed = shown.getByRole("list", { name: "Remove" });
    expect(removed.closest(".roles-plan-group")).toHaveClass("remove");
    expect(within(removed).getByRole("button", { name: `Copy Discord user ID ${members.revoked}` })).toBeVisible();
    expect(within(removed).getByText(/UNC application was revoked/)).toBeInTheDocument();
    expect(shown.getByText(/1 role would be removed. Removals need a careful look/)).toBeInTheDocument();
    expect(shown.getByText("No change in Discord (2)")).toBeInTheDocument();
    expect(shown.queryByText(/stopped at 100 entries/)).not.toBeInTheDocument();
    expect(shown.getByText(/A preview changes nothing in Discord/)).toBeInTheDocument();
  });

  it("says plainly when the plan is capped at 100 entries", async () => {
    const plan = Array.from({ length: 100 }, (_, index) => ({
      ...adds[0],
      discordUserId: `3300000000000${String(index).padStart(5, "0")}`,
    }));
    serve(rolesStatus(), () => dryRun(plan));
    render(page());
    await preview();
    const shown = within(screen.getByRole("region", { name: "Preview of role changes" }));
    expect(shown.getByText("This preview stopped at 100 entries.")).toBeInTheDocument();
    expect(shown.getByText(/The real run may change more people than are listed here/)).toBeInTheDocument();
    expect(shown.queryByText(/would be removed/)).not.toBeInTheDocument();
  });

  it("says when nothing would change and when the preview could not finish", async () => {
    serve(rolesStatus(), () => dryRun([]));
    const view = render(page());
    await preview();
    expect(screen.getByText("Nothing would change")).toBeInTheDocument();
    view.unmount();
    serve(rolesStatus({ enabled: true }), () =>
      dryRun([], { error: "Setup: No role can be assigned. Fix the role setup on the Discord roles page." }),
    );
    render(page());
    await preview();
    expect(screen.getByText(/The preview did not finish/).closest("p")).toHaveTextContent(
      "Setup: No role can be assigned",
    );
    expect(screen.queryByText("Nothing would change")).not.toBeInTheDocument();
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription("The latest preview did not finish. Preview again first.");
  });
});

describe("run role check", () => {
  it("stays off while the feature is switched off, even after a preview", async () => {
    serve(rolesStatus(), () => dryRun(adds));
    render(page());
    await screen.findByText("Setup checks");
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription("Switched off in Railway: DISCORD_ROLES_ENABLED=false");
    await preview();
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription("Switched off in Railway: DISCORD_ROLES_ENABLED=false");
    fireEvent.click(runButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each<[string, Partial<DiscordRolesStatus>, string]>([
    ["setup fails", { enabled: true, ready: false }, "Fix the setup checks above before running a role check."],
    [
      "a check is running",
      { enabled: true, running: true },
      "A role check is running now. Try again when it finishes.",
    ],
  ])("stays off while %s", async (_case, overrides, reason) => {
    serve(rolesStatus(overrides));
    render(page());
    await screen.findByText("Setup checks");
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription(reason);
  });

  it("requires a preview, confirms its counts with a reason, then posts the real run", async () => {
    let status = rolesStatus({ enabled: true });
    serve(
      () => status,
      (body) =>
        body.dryRun
          ? dryRun([...adds, removal, ...notes])
          : {
              ok: true,
              replayed: false,
              summary: pass({ trigger: "admin", added: 2, removed: 1, noted: 1, failed: 0, deferred: 0 }),
            },
    );
    render(page());
    await screen.findByText("Setup checks");
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription("Preview the changes first, so you can see what would change.");
    await preview();
    expect(runButton()).toBeEnabled();
    expect(runButton()).not.toHaveAccessibleDescription();
    fireEvent.click(runButton());
    const dialog = within(screen.getByRole("dialog", { name: "Run role check now" }));
    expect(dialog.getByText("Add: 2 roles")).toBeInTheDocument();
    expect(dialog.getByText("Remove: 1 role")).toBeInTheDocument();
    expect(dialog.getByText("No change in Discord: 2 entries")).toBeInTheDocument();
    expect(dialog.getByText("This run would remove 1 role.")).toBeInTheDocument();
    expect(dialog.getByText(/nobody is pinged/)).toBeInTheDocument();
    // The reason is required: the browser blocks an empty one, and the page checks it too.
    const reason = dialog.getByRole("textbox", { name: "Reason" });
    expect(reason).toBeRequired();
    fireEvent.change(reason, { target: { value: "x" } });
    fireEvent.submit(reason.closest("form")!);
    expect(dialog.getByRole("alert")).toHaveTextContent("Enter a single-line reason between 3 and 200 characters.");
    expect(posts()).toHaveLength(1);
    const readsBefore = reads();
    status = rolesStatus({ enabled: true, lastPass: pass({ trigger: "admin" }) });
    fireEvent.change(reason, { target: { value: "Backfill after the role setup review" } });
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    await screen.findByRole("dialog", { name: "Role check finished" });
    const run = posts()[1];
    expect(run.path).toBe("discord-roles/reconcile");
    expect(run.body).toEqual({ id: expect.stringMatching(uuid), reason: "Backfill after the role setup review" });
    expect(run.body.id).not.toBe(posts()[0].body.id);
    const result = within(screen.getByRole("dialog"));
    expect(result.getByText("Added").nextElementSibling).toHaveTextContent("2");
    expect(result.getByText("Removed").nextElementSibling).toHaveTextContent("1");
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
    fireEvent.click(result.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The preview described the run that just happened, so another run needs a new preview.
    expect(screen.queryByRole("region", { name: "Preview of role changes" })).not.toBeInTheDocument();
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAccessibleDescription("Preview the changes first, so you can see what would change.");
  });

  it("asks for a fresh preview after 10 minutes", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    serve(rolesStatus({ enabled: true }), () => dryRun(adds));
    const view = render(page());
    await preview();
    expect(runButton()).toBeEnabled();
    clock.mockReturnValue(now + 11 * 60_000);
    view.rerender(page({ ...context, refreshVersion: 1 }));
    await waitFor(() =>
      expect(runButton()).toHaveAccessibleDescription("The preview is more than 10 minutes old. Preview again first."),
    );
    expect(runButton()).toBeDisabled();
  });

  it("keeps the form open when the server refuses the run, so it can be sent again", async () => {
    let refuse = true;
    serve(rolesStatus({ enabled: true }), (body) => {
      if (body.dryRun) return dryRun(adds);
      if (refuse) throw failure(429, "Wait 30 seconds between role checks.");
      return { ok: true, replayed: false, summary: pass({ trigger: "admin" }) };
    });
    render(page());
    await preview();
    fireEvent.click(runButton());
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), { target: { value: "Monthly role check" } });
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Gramps allows one role check every 30 seconds, previews included. Wait a moment, then try again.",
    );
    expect(screen.getByRole("dialog", { name: "Run role check now" })).toBeInTheDocument();
    refuse = false;
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    await screen.findByRole("dialog", { name: "Role check finished" });
    const [, first, second] = posts();
    expect(second.body.reason).toBe("Monthly role check");
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("reports an unconfirmed run without claiming it failed or succeeded", async () => {
    serve(rolesStatus({ enabled: true }), (body) => {
      if (body.dryRun) return dryRun([removal]);
      throw failure(0, "The connection ended before confirmation.");
    });
    render(page());
    await preview();
    fireEvent.click(runButton());
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Remove revoked UNC roles" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    await screen.findByRole("dialog", { name: "Role check result not confirmed" });
    expect(screen.getByRole("alert")).toHaveTextContent("the role check may still have run");
    expect(screen.queryByRole("button", { name: "Run role check" })).not.toBeInTheDocument();
  });
});

describe("errors", () => {
  it("explains calmly when this server version has no roles feature", async () => {
    request.mockRejectedValue(failure(404, "Cannot GET /admin/api/discord-roles"));
    render(page());
    expect(await screen.findByText("Discord roles aren’t available on this version")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview changes" })).not.toBeInTheDocument();
  });

  it("says administrator access is required on a 403", async () => {
    request.mockRejectedValue(failure(403, "Your staff session or access could not be verified. Sign in again."));
    render(page());
    expect(await screen.findByRole("alert")).toHaveTextContent("Only administrators can manage Discord roles.");
  });

  it("reports a failed read, and keeps the last status with a warning when a refresh fails", async () => {
    request.mockRejectedValueOnce(failure(503, "Discord roles are temporarily unavailable. No role change was sent."));
    const view = render(page());
    expect(await screen.findByRole("alert")).toHaveTextContent("Discord roles could not be loaded");
    serve(rolesStatus({ enabled: true }), () => dryRun(adds));
    view.rerender(page({ ...context, refreshVersion: 1 }));
    await screen.findByText("Setup checks");
    await preview();
    expect(runButton()).toBeEnabled();
    request.mockRejectedValueOnce(failure(0, "The dashboard request timed out. Try refreshing this page."));
    view.rerender(page({ ...context, refreshVersion: 2 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Discord roles could not be refreshed");
    expect(screen.getByText("Setup checks")).toBeInTheDocument();
    expect(runButton()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/could not be refreshed/);
  });

  it.each<[number, string, string]>([
    [409, "A role check is already running. Try again when it finishes.", "A role check is already running."],
    [429, "Wait 30 seconds between role checks.", "Gramps allows one role check every 30 seconds"],
    [503, "Discord is not connected yet. Try again shortly.", "Discord is not connected yet. Try again shortly."],
    [404, "Cannot POST /admin/api/discord-roles/reconcile", "This server version has no Discord roles feature yet."],
  ])("explains a %i from the preview", async (status, message, shown) => {
    serve(rolesStatus(), () => {
      throw failure(status, message);
    });
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: "Preview changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
    expect(screen.queryByRole("region", { name: "Preview of role changes" })).not.toBeInTheDocument();
  });

  it("explains a 503 from a real run with the server's reason", async () => {
    serve(rolesStatus({ enabled: true }), (body) => {
      if (body.dryRun) return dryRun(adds);
      throw failure(503, "Discord roles are switched off (DISCORD_ROLES_ENABLED=false).");
    });
    render(page());
    await preview();
    fireEvent.click(runButton());
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), { target: { value: "Monthly role check" } });
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Run role check" })));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Discord roles are switched off (DISCORD_ROLES_ENABLED=false). No role change was sent.",
    );
  });
});
