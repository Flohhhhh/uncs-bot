import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { AdminContext, type AdminContextValue } from "../../app/context";
import { DiscordRolesPage } from "./index";
import { adds, dryRun, ledgerRow, members, notes, pass, removal, rolesStatus, unreadStatus } from "./test-fixtures";
import type { DiscordRolesStatus, ReconcileResponse } from "./types";

vi.mock("../../api/client", () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const context: AdminContextValue = {
  me: { id: "12345678901234567", name: "Admin", role: "admin", csrf: "fixture" },
  overview: null,
  stale: true,
  checking: false,
  busy: false,
  dialogOpen: false,
  refreshVersion: 0,
  setBusy: vi.fn(),
  setDialogOpen: vi.fn(),
  setUnsavedChanges: vi.fn(),
  refresh: vi.fn(),
  invalidateOverview: vi.fn(),
  openAction: vi.fn(),
  watchRoster: vi.fn(),
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
const setupRow = (title: string) =>
  ([...screen.getByRole("list", { name: "Setup checks" }).children] as HTMLElement[]).find(
    (item) => item.querySelector("strong")?.textContent === title,
  )!;
/** Opens the run confirmation from a fresh preview and fills in a reason. */
async function openRun(reason = "Monthly role check") {
  await preview();
  fireEvent.click(runButton());
  const dialog = within(screen.getByRole("dialog", { name: "Run role check now" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Reason" }), { target: { value: reason } });
  return dialog;
}
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
      unreadStatus("Discord is not connected yet.", { enabled: true, running: true, queued: 3, fullPassQueued: true }),
    );
    render(page());
    await waitFor(() => expect(statusLine()).toHaveTextContent("Automatic Discord roles: On"));
    expect(statusLine()).toHaveTextContent("Discord not connected");
    expect(statusLine()).toHaveTextContent("A role check is running now");
    expect(statusLine()).toHaveTextContent("3 people waiting for a check");
    // No role was checked, so none is said to fail.
    expect(screen.getByText(/Gramps can’t read the Discord server yet, so it changes no roles/)).toBeInTheDocument();
    expect(screen.queryByText(/a role fails its setup checks/)).not.toBeInTheDocument();
    expect(setupRow("Bot can manage roles")).toHaveTextContent("Not checked: Discord is not connected yet.");
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/Discord is not connected yet/);
  });

  it("says a role is not checked, rather than missing, while the server could not read Discord", async () => {
    serve(unreadStatus("The Discord server could not be read. Check that the bot is in ADMIN_GUILD_ID."));
    render(page());
    await screen.findByRole("list", { name: "Setup checks" });
    const unc = within(setupRow("UNC role"));
    expect(setupRow("UNC role")).toHaveTextContent("Not read from Discord yet");
    expect(setupRow("UNC role")).not.toHaveTextContent("No Discord role found");
    expect(unc.getByText("Exists in Discord").nextElementSibling).toHaveTextContent("Not checked");
    expect(unc.getByText("Gramps can assign it").nextElementSibling).toHaveTextContent("Not checked");
    expect(unc.queryByText("Needs a fix")).not.toBeInTheDocument();
    // The shared reason is shown once, on the bot row, not as a fix for each role.
    expect(setupRow("UNC role")).not.toHaveTextContent("Fix:");
    expect(setupRow("Bot can manage roles")).toHaveTextContent(
      "Not checked: The Discord server could not be read. Check that the bot is in ADMIN_GUILD_ID.",
    );
    const supporter = setupRow("Supporter role (optional)");
    expect(within(supporter).getByText("Optional · not set up")).toBeInTheDocument();
    expect(supporter).toHaveTextContent("No role ID set");
    expect(supporter).not.toHaveTextContent("To add it: The Discord server could not be read");
    expect(supporter).toHaveTextContent("Without DISCORD_SUPPORTER_ROLE_ID, Gramps skips the Supporter role");
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
  expect(within(row("UNC role")).getByText("Position").nextElementSibling).toHaveTextContent("9");
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
  // Each detail names what the server counts: people (not applications), and supporters with Discord linked.
  expect(counts.getByText("UNC eligible").nextElementSibling).toHaveTextContent(
    "People with an approved UNC member application",
  );
  expect(counts.getByText("Supporters now").nextElementSibling).toHaveTextContent(
    "Support right now, with Discord linked",
  );
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
  expect(attention.getByText(/Not in the Discord server. Gramps checks them again when they join./)).toBeVisible();
  const ledger = within(screen.getByRole("table", { name: "Recent role changes" }));
  expect(ledger.getAllByRole("row")).toHaveLength(26);
  expect(ledger.getByRole("button", { name: `Copy Discord user ID ${ledgerRow(1).discordUserId}` })).toBeVisible();
  expect(ledger.queryByText(ledgerRow(26).discordUserId)).not.toBeInTheDocument();
});

it("says a failed member read changed no roles, rather than calling it a failed role change", async () => {
  serve(
    rolesStatus({ attention: [{ kind: "failed", discordUserId: members.refused, at: "2026-10-03T09:00:00.000Z" }] }),
  );
  render(page());
  const attention = within(await screen.findByRole("list", { name: "Needs attention" }));
  expect(
    attention.getByText(/could not read this member from Discord, so it changed none of their roles/),
  ).toBeVisible();
  expect(attention.queryByText(/role change failed/)).not.toBeInTheDocument();
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
    expect(shown.getByText("This preview stopped after 100 entries, its limit.")).toBeInTheDocument();
    expect(shown.getByText(/The real run may change more people than are listed here/)).toBeInTheDocument();
    expect(shown.queryByText(/would be removed/)).not.toBeInTheDocument();
  });

  it("shows a preview that ends with one person's three roles, past 100 entries", async () => {
    // The server plans each person's roles together, so the last person can take the plan to 102 entries.
    const plan = [
      ...Array.from({ length: 99 }, (_, index) => ({
        ...adds[0],
        discordUserId: `3300000000000${String(index).padStart(5, "0")}`,
      })),
      { discordUserId: members.founder, roleKind: "member" as const, op: "add", why: "desired" },
      { discordUserId: members.founder, roleKind: "founder" as const, op: "add", why: "desired" },
      { discordUserId: members.founder, roleKind: "supporter" as const, op: "add", why: "desired" },
    ];
    serve(rolesStatus(), () => dryRun(plan));
    render(page());
    await preview();
    const shown = within(screen.getByRole("region", { name: "Preview of role changes" }));
    expect(shown.getByText("Add", { selector: "dt" }).nextElementSibling).toHaveTextContent("102");
    expect(shown.getByText("This preview stopped after 102 entries, its limit.")).toBeInTheDocument();
    expect(screen.queryByText(/The preview could not be read/)).not.toBeInTheDocument();
  });

  it("announces a finished preview while focus stays on its button", async () => {
    serve(rolesStatus(), () => dryRun([...adds, removal, ...notes]));
    render(page());
    await preview();
    expect(screen.getByText("Preview ready: 2 roles to add and 1 role to remove.")).toHaveAttribute("role", "status");
  });

  it("keeps focus on Preview changes while its preview runs, and ignores another press", async () => {
    let answer!: (value: ReconcileResponse) => void;
    serve(rolesStatus(), () => new Promise<ReconcileResponse>((resolve) => (answer = resolve)));
    render(page());
    const button = await screen.findByRole("button", { name: "Preview changes" });
    button.focus();
    fireEvent.click(button);
    const running = await screen.findByRole("button", { name: "Previewing…" });
    // A disabled button would drop focus to the page in a browser; aria-disabled keeps it on the button.
    expect(running).toBe(button);
    expect(running).not.toBeDisabled();
    expect(running).toHaveAttribute("aria-disabled", "true");
    expect(running).toHaveFocus();
    fireEvent.click(running);
    expect(posts()).toHaveLength(1);
    await act(async () => answer(dryRun(adds)));
    await screen.findByRole("region", { name: "Preview of role changes" });
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("sends one preview for a double click", async () => {
    serve(rolesStatus(), () => dryRun(adds));
    render(page());
    const button = await screen.findByRole("button", { name: "Preview changes" });
    // Both clicks land before React re-renders the button as disabled.
    act(() => {
      button.click();
      button.click();
    });
    await screen.findByRole("region", { name: "Preview of role changes" });
    expect(posts()).toHaveLength(1);
  });

  it("does not say nothing would change when a role was skipped or members could not be read", async () => {
    serve(rolesStatus(), () => dryRun([], { blocked: 1, failed: 2 }));
    render(page());
    await preview();
    const shown = within(screen.getByRole("region", { name: "Preview of role changes" }));
    expect(shown.getByText("1 role fails its setup checks, so this preview leaves it out.")).toBeInTheDocument();
    expect(shown.getByText("Gramps could not read 2 people from Discord.").closest("p")).toHaveTextContent(
      "This preview leaves out their roles.",
    );
    expect(shown.getByText("No changes found")).toBeInTheDocument();
    expect(shown.queryByText("Nothing would change")).not.toBeInTheDocument();
    expect(shown.queryByText(/Everyone already has the roles/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Preview ready: 0 roles to add and 0 roles to remove. Some roles or people could not be checked.",
      ),
    ).toHaveAttribute("role", "status");
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

  it("refuses to send a run from a dialog left open past the 10-minute preview limit", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    serve(rolesStatus({ enabled: true }), () => dryRun(adds));
    render(page());
    const dialog = await openRun();
    clock.mockReturnValue(now + 11 * 60_000);
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("This preview is more than 10 minutes old.");
    expect(posts()).toHaveLength(1);
  });

  it("sends one run for a double click on Run role check", async () => {
    let finish!: (value: ReconcileResponse) => void;
    serve(rolesStatus({ enabled: true }), (body) =>
      body.dryRun ? dryRun(adds) : new Promise<ReconcileResponse>((resolve) => (finish = resolve)),
    );
    render(page());
    const dialog = await openRun();
    const submit = dialog.getByRole("button", { name: "Run role check" });
    // Both clicks land before React re-renders, while the reason field and the button are still enabled.
    act(() => {
      submit.click();
      submit.click();
    });
    expect(posts().filter((post) => !post.body.dryRun)).toHaveLength(1);
    await act(async () => finish({ ok: true, replayed: false, summary: pass({ trigger: "admin" }) }));
    await screen.findByRole("dialog", { name: "Role check finished" });
    expect(posts().filter((post) => !post.body.dryRun)).toHaveLength(1);
  });

  it("refuses a reason with the DEL character, as the server does", async () => {
    serve(rolesStatus({ enabled: true }), () => dryRun(adds));
    render(page());
    const dialog = await openRun("Monthly\u007f check");
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("Enter a single-line reason");
    expect(posts()).toHaveLength(1);
  });

  it("says a run stopped early instead of finished when its summary carries an error", async () => {
    const error = "The role pass stopped early because Discord or the database was unavailable.";
    serve(rolesStatus({ enabled: true }), (body) =>
      body.dryRun ? dryRun(adds) : { ok: true, replayed: false, summary: pass({ trigger: "admin", error }) },
    );
    render(page());
    const dialog = await openRun();
    fireEvent.click(dialog.getByRole("button", { name: "Run role check" }));
    const result = await screen.findByRole("dialog", { name: "Role check stopped early" });
    expect(result).toHaveTextContent(error);
    expect(result).toHaveTextContent("Any change it made before stopping is kept");
    expect(result).not.toHaveTextContent("Gramps finished checking everyone");
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
      "Gramps allows one role check every 30 seconds. Previews don’t count toward this wait. Wait a moment, then try again.",
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
    [409, "A preview is already running. Try again when it finishes.", "A preview is already running."],
    [429, "Wait 5 seconds between previews.", "Gramps allows one preview every 5 seconds."],
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

  it("treats a 403 from a real run as refused, not as a run that may have happened", async () => {
    serve(rolesStatus({ enabled: true }), (body) => {
      if (body.dryRun) return dryRun(adds);
      throw failure(403, "Your staff session or access could not be verified. Sign in again.");
    });
    render(page());
    const dialog = await openRun();
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Run role check" })));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Only administrators can manage Discord roles.");
    expect(screen.getByRole("dialog", { name: "Run role check now" })).toBeInTheDocument();
    expect(screen.queryByText(/may still have run/)).not.toBeInTheDocument();
  });
});
