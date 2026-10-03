import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, type To } from "react-router-dom";
import { api, configureSession, isReadPending } from "../api/client";
import { validateOverview, validateStaff, validateServers } from "../api/validation";
import type { ActionName, Overview, Staff } from "../api/types";
import { AdminContext, type ActionOptions, type SelectedServer } from "./context";
import { Empty, Sheet } from "../components/ui";
import { OverviewPage, WhitelistPage, BansPage, AnnouncementsPage } from "../features/server/pages";
import { MatchPage } from "../features/server/match-page";
import { PlayersPage } from "../features/players/players-page";
import { ActionsDialog } from "../features/actions/actions-dialog";
import { ApplicationsPage } from "../features/applications";
import { SupportersPage } from "../features/supporters";
import { SettingsPage, PermissionsPage } from "../features/server/settings-page";
import { NavigationGuard } from "./navigation-guard";
import { serverSearch } from "./server-link";
import { ServerChoices, ServerSwitcher } from "./server-switcher";
import { AccountDetails, AccountMenu, StatusPill } from "./shell";
import { ActivityPage } from "../features/server/activity-page";

type Page = { icon: string; label: string; title: string; short?: string };
/** `label` names the page in navigation and the tab title; `title` is its heading; `short` fits the phone tab bar. */
const pages = {
  overview: { icon: "◫", label: "Overview", title: "Server overview", short: "Overview" },
  players: { icon: "♟", label: "Players", title: "Live players", short: "Players" },
  match: { icon: "◇", label: "Match & maps", title: "Match & maps", short: "Match" },
  activity: { icon: "◷", label: "Server activity", title: "Server activity", short: "Activity" },
  whitelist: { icon: "☷", label: "Whitelist", title: "Community whitelist" },
  applications: { icon: "✉", label: "Applications", title: "Whitelist applications" },
  bans: { icon: "⊘", label: "Bans", title: "Server bans" },
  announcements: { icon: "↗", label: "Announcements", title: "Announcements" },
  supporters: { icon: "✳", label: "Supporters", title: "Community supporters" },
  settings: { icon: "⚙", label: "Settings", title: "Server settings" },
  permissions: { icon: "◈", label: "Permissions", title: "Staff permissions" },
} satisfies Record<string, Page>;
type PageId = keyof typeof pages;
/** The first group is the phone tab bar; the others open from More. */
const navigation: { label: string; pages: PageId[] }[] = [
  { label: "Live", pages: ["overview", "players", "match", "activity"] },
  { label: "Community", pages: ["whitelist", "applications", "bans", "announcements", "supporters"] },
  { label: "Server", pages: ["settings"] },
];
/** Old standalone pages are now views of a hub. The redirect keeps the server and any other parameters. */
function ViewRedirect({ to, view }: { to: string; view: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("view", view);
  return <Navigate to={{ pathname: to, search: `?${params}` }} replace />;
}
function Brand({ className = "" }: { className?: string }) {
  return (
    <a className={`wordmark ${className}`} href="https://theuncsgaming.com/" aria-label="The UNCs home">
      <span className="wordmark-the">THE</span>
      <span>
        UNCs
        <span className="wordmark-star" aria-hidden="true">
          ✳
        </span>
      </span>
    </a>
  );
}
function Login({ message }: { message: string }) {
  useEffect(() => {
    document.title = "Staff sign-in · The UNCs";
  }, []);
  return (
    <div className="login-screen">
      <Brand className="login-brand" />
      <div className="login-card">
        <div className="login-copy">
          <p className="eyebrow">✳ THE UNCs / STAFF ACCESS</p>
          <h1>
            GOOD COMMS.
            <br />
            <span>GOOD HANDS.</span>
          </h1>
          <p>
            Look after the match. Look after the crew. Your community’s players, whitelist, and server controls, all in
            one place.
          </p>
          <a className="button primary" href="/admin/auth/login">
            Continue with Discord ↗
          </a>
          <p className="muted" role="status">
            {message || "Use a Discord account with an assigned staff role."}
          </p>
        </div>
        <div className="login-art" aria-hidden="true">
          <img src="/admin/assets/uncs-mascot.png" width="1254" height="1254" alt="" />
          <span>
            THE SERVER’S OURS.
            <br />
            LET’S LOOK AFTER IT.
          </span>
        </div>
      </div>
      <div className="login-footer">
        <a href="https://theuncsgaming.com/">← Back to the community</a>
        <span>THE UNCs · POWERED BY GRAMPS</span>
      </div>
    </div>
  );
}
export function App() {
  const location = useLocation(),
    navigate = useNavigate();
  const [me, setMe] = useState<Staff | null>(null);
  const [available, setAvailable] = useState<{ legacy: boolean; servers: SelectedServer[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const expire = useCallback((reason: string) => {
    setMe(null);
    setAvailable(null);
    setMessage(reason);
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    configureSession("", expire);
    void api<Staff>("me", { signal: controller.signal })
      .then(async (value) => {
        if (controller.signal.aborted) return;
        const staff = validateStaff(value);
        configureSession(staff.csrf, expire);
        const servers = validateServers(await api("servers", { signal: controller.signal }));
        if (controller.signal.aborted) return;
        setAvailable(servers);
        setMe(staff);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) expire(error instanceof Error ? error.message : "Sign in to continue.");
      });
    return () => {
      controller.abort();
      configureSession("");
    };
  }, [expire]);
  if (loading) return <Empty title="Checking staff access…" />;
  const selectedId = new URLSearchParams(location.search).get("server") ?? (available?.legacy ? "primary" : "");
  const server = available?.servers.find((server) => server.id === selectedId);
  if (me && available && !server)
    return (
      <div className="login-screen">
        <Brand />
        <CardServerChoice
          servers={available.servers}
          invalid={!!selectedId}
          choose={(id) => navigate({ pathname: location.pathname, search: `?server=${id}` })}
        />
      </div>
    );
  return me && server && available ? (
    <Dashboard
      key={`${me.id}:${server.id}:${server.version}`}
      me={me}
      server={server}
      servers={available.servers}
      signOut={() => {
        configureSession("");
        expire("Signed out.");
      }}
    />
  ) : (
    <Login message={message} />
  );
}
function CardServerChoice({
  servers,
  choose,
  invalid,
}: {
  servers: SelectedServer[];
  choose: (id: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="login-card">
      <div className="login-copy">
        <h1>Choose a server</h1>
        <p>
          {invalid
            ? "That server is unavailable or outside your staff access."
            : "Select the server you want to manage."}
        </p>
        {servers.length ? (
          <ServerChoices servers={servers} choose={choose} />
        ) : (
          <p>No game servers are available to this staff account.</p>
        )}
      </div>
    </div>
  );
}
function Dashboard({
  me,
  server,
  servers,
  signOut,
}: {
  me: Staff;
  server: SelectedServer;
  servers: SelectedServer[];
  signOut: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const key = location.pathname.split("/").filter(Boolean)[0] || "overview";
  const page: PageId = Object.hasOwn(pages, key) ? (key as PageId) : "overview";
  const canOpen = (id: PageId) =>
    id === "supporters"
      ? me.role === "admin"
      : ["applications", "settings"].includes(id)
        ? server.role === "admin"
        : true;
  const groups = navigation
    .map((group) => ({ ...group, pages: group.pages.filter(canOpen) }))
    .filter((group) => group.pages.length);
  const moreActive = key === "permissions" || groups.slice(1).some((group) => (group.pages as string[]).includes(key));
  const gamePage = ["overview", "players", "whitelist", "bans", "announcements", "match"].includes(key);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stale, setStale] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [unsavedChanges, setUnsavedChanges] = useState(false);
  const [logoutRequested, setLogoutRequested] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // Records pages do not read the live game, except for a player panel opened on them, which asks for the roster.
  const [rosterWatchers, setRosterWatchers] = useState(0);
  const liveRoster = gamePage || rosterWatchers > 0;
  // The refresh that the latest finished overview read answered; null while no read is wanted.
  const [answered, setAnswered] = useState<number | null>(null);
  const checking = liveRoster && answered !== refreshVersion;
  const [logoutError, setLogoutError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  // A link inside a review waits until the review has closed, so the navigation guard lets it through.
  const [afterDialog, setAfterDialog] = useState<To | null>(null);
  const [action, setAction] = useState<{
    action: ActionName;
    steamId?: string;
    initialMessage?: string;
    key: string;
  } | null>(null);
  const pause = useRef(false);
  const freshness = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || dialogOpen;
  pause.current = locked;
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const invalidateOverview = useCallback(() => {
    freshness.current++;
    setStale(true);
  }, []);
  const watchRoster = useCallback(() => {
    setRosterWatchers((count) => count + 1);
    return () => setRosterWatchers((count) => count - 1);
  }, []);
  const openAction = useCallback(
    (action: ActionName, steamId?: string, options?: ActionOptions) =>
      setAction({ action, steamId, initialMessage: options?.initialMessage, key: crypto.randomUUID() }),
    [],
  );
  useEffect(() => {
    document.title = `${pages[page].label} · The UNCs Admin`;
    heading.current?.focus();
  }, [location.pathname, page]);
  useEffect(() => setMoreOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!afterDialog || locked) return;
    setAfterDialog(null);
    navigate(afterDialog);
  }, [afterDialog, locked, navigate]);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden && !pause.current && !isReadPending()) refresh();
    };
    const visibilityChanged = () => {
      // A sleeping tab must not advertise its old player list as current.
      invalidateOverview();
      tick();
    };
    const timer = window.setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [refresh, invalidateOverview]);
  useEffect(() => {
    if (!liveRoster) {
      setStale(true);
      setAnswered(null);
      return;
    }
    const controller = new AbortController();
    const requestedFreshness = freshness.current;
    const requestedVersion = refreshVersion;
    void api<Overview>(`servers/${server.id}/overview`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setOverview(validateOverview(value));
          setStale(document.hidden || requestedFreshness !== freshness.current);
          setError("");
          setAnswered(requestedVersion);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStale(true);
          setError(error instanceof Error ? error.message : "The server could not be read.");
          setAnswered(requestedVersion);
        }
      });
    return () => controller.abort();
  }, [liveRoster, refreshVersion, server.id]);
  useEffect(() => {
    if (!overview) return;
    // Expire an unattended confirmation without adding another polling loop.
    const timer = window.setTimeout(() => setStale(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [overview]);
  async function logout() {
    if (busy) return;
    setLogoutError("");
    setBusy(true);
    try {
      await api("logout", { method: "POST", body: "{}" });
      signOut();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Sign out failed.");
    } finally {
      setBusy(false);
    }
  }
  function requestLogout() {
    if (locked) return;
    if (unsavedChanges) setLogoutRequested(true);
    else void logout();
  }
  const switchServer = (id: string) => navigate({ pathname: location.pathname, search: `?server=${id}` });
  const staffPage = (element: React.ReactNode, game = false) =>
    (game ? server.role : me.role) === "admin" ? (
      element
    ) : (
      <Navigate to={{ pathname: "/overview", search: serverSearch(location.search) }} replace />
    );
  const sectionLink = (id: PageId, onNavigate?: () => void) => {
    const item: Page = pages[id];
    return (
      <NavLink
        // Only the server follows staff to another section; page views such as `?view=` stay behind.
        to={{ pathname: `/${id}`, search: serverSearch(location.search) }}
        className={({ isActive }) => (isActive || id === key ? "active" : "")}
        aria-current={id === key ? "page" : undefined}
        onClick={(event) => {
          if (locked) event.preventDefault();
          else onNavigate?.();
        }}
      >
        <span className="nav-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="nav-text">{item.label}</span>
        {item.short && (
          <span className="nav-short" aria-hidden="true">
            {item.short}
          </span>
        )}
      </NavLink>
    );
  };
  const account = {
    me,
    role: server.role,
    build: gamePage ? overview?.capabilities.build : undefined,
    disabled: locked,
  };
  return (
    <AdminContext.Provider
      value={{
        me,
        server,
        overview,
        stale,
        checking,
        watchRoster,
        busy,
        setBusy,
        dialogOpen,
        setDialogOpen,
        setUnsavedChanges,
        refreshVersion,
        refresh,
        invalidateOverview,
        openAction,
      }}
    >
      <a className="skip-link" href="#main-content">
        Skip to dashboard
      </a>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <Brand />
            <span className="admin-label">SERVER ADMIN</span>
          </div>
          <nav aria-label="Dashboard sections" className="sections">
            {groups.map((group, index) => (
              <div key={group.label} className={`nav-group${index === 0 ? " nav-primary" : ""}`}>
                <p className="nav-label" id={`nav-${group.label.toLowerCase()}`}>
                  {group.label}
                </p>
                <ul aria-labelledby={`nav-${group.label.toLowerCase()}`}>
                  {group.pages.map((id) => (
                    <li key={id}>{sectionLink(id)}</li>
                  ))}
                </ul>
              </div>
            ))}
            <button
              type="button"
              className={`nav-more${moreActive ? " active" : ""}`}
              aria-label="More sections"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              disabled={locked}
              onClick={() => setMoreOpen(true)}
            >
              <span className="nav-icon" aria-hidden="true">
                ☰
              </span>
              <span>More</span>
            </button>
          </nav>
        </aside>
        <main id="main-content" tabIndex={-1}>
          {me.demo && (
            <div className="demo-banner">
              <strong>Local preview</strong> <span>Sample data. Not the live server.</span>
            </div>
          )}
          <header className="topbar">
            <ServerSwitcher servers={servers} current={server} disabled={locked} choose={switchServer} />
            <p className="topbar-server">
              <span className="sr-only">Game server:</span> <strong>{server.name}</strong>{" "}
              <span className="server-role">{server.role}</span>
            </p>
            <div className="topbar-right">
              {gamePage && (
                <StatusPill overview={overview} stale={stale} error={error} disabled={locked} retry={refresh} />
              )}
              <button
                type="button"
                className="icon-button refresh-button"
                aria-label="Refresh dashboard"
                title="Refresh"
                disabled={locked}
                onClick={refresh}
              >
                ↻
              </button>
              <AccountMenu {...account} signOut={requestLogout} />
            </div>
          </header>
          <div className="content">
            <div className="page-heading">
              <h1 ref={heading} tabIndex={-1}>
                {pages[page].title}
              </h1>
            </div>
            {gamePage && error && (
              <div className="notice error notice-retry" role="alert">
                <p>{error}</p>
                <button type="button" className="button secondary small" disabled={locked} onClick={refresh}>
                  Retry
                </button>
              </div>
            )}
            {logoutError && (
              <div className="notice error" role="alert">
                {logoutError}
              </div>
            )}
            <section id="page" data-stale={gamePage && overview && stale ? "" : undefined}>
              <Routes>
                <Route index element={<Navigate to={{ pathname: "/overview", search: location.search }} replace />} />
                <Route path="overview" element={<OverviewPage />} />
                <Route path="players" element={<PlayersPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="whitelist" element={<WhitelistPage />} />
                <Route path="bans" element={<BansPage />} />
                <Route path="announcements" element={<AnnouncementsPage />} />
                <Route path="match" element={<MatchPage />} />
                <Route path="votes" element={<ViewRedirect to="/match" view="voting" />} />
                <Route path="events" element={<ViewRedirect to="/match" view="events" />} />
                <Route path="audit" element={<ViewRedirect to="/activity" view="actions" />} />
                <Route path="combat" element={<ViewRedirect to="/activity" view="combat" />} />
                <Route path="settings" element={staffPage(<SettingsPage />, true)} />
                <Route path="permissions" element={<PermissionsPage />} />
                <Route path="applications" element={staffPage(<ApplicationsPage />, true)} />
                <Route path="supporters" element={staffPage(<SupportersPage />)} />
                <Route
                  path="*"
                  element={<Empty title="Page not found" detail="Choose a section from the staff menu." />}
                />
              </Routes>
            </section>
            <footer>
              THE UNCs <span aria-hidden="true">✳</span> POWERED BY GRAMPS
            </footer>
          </div>
        </main>
      </div>
      {moreOpen && (
        <Sheet title="More" onClose={() => setMoreOpen(false)} className="more-sheet">
          <ServerSwitcher
            servers={servers}
            current={server}
            disabled={locked}
            choose={(id) => {
              setMoreOpen(false);
              switchServer(id);
            }}
          />
          <nav aria-label="More sections" className="more-sections">
            {groups.slice(1).map((group) => (
              <div key={group.label}>
                <p className="nav-label" id={`more-${group.label.toLowerCase()}`}>
                  {group.label}
                </p>
                <ul aria-labelledby={`more-${group.label.toLowerCase()}`}>
                  {group.pages.map((id) => (
                    <li key={id}>{sectionLink(id, () => setMoreOpen(false))}</li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <AccountDetails
            {...account}
            onNavigate={() => setMoreOpen(false)}
            signOut={() => {
              setMoreOpen(false);
              requestLogout();
            }}
          />
        </Sheet>
      )}
      {action && (
        <ActionsDialog
          key={action.key}
          action={action.action}
          steamId={action.steamId}
          initialMessage={action.initialMessage}
          onClose={() => setAction(null)}
          onNavigate={(to) => {
            setAction(null);
            setAfterDialog(to);
          }}
        />
      )}
      <NavigationGuard
        unsaved={unsavedChanges}
        logoutRequested={logoutRequested}
        cancelLogout={() => setLogoutRequested(false)}
        confirmLogout={() => {
          setLogoutRequested(false);
          void logout();
        }}
      />
    </AdminContext.Provider>
  );
}
