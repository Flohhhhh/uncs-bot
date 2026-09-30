import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, configureSession } from "../api/client";
import type { ActionName, Overview, Staff } from "../api/types";
import { AdminContext } from "./context";
import { Badge, Empty } from "../components/ui";
import {
  OverviewPage,
  WhitelistPage,
  BansPage,
  AnnouncementsPage,
  MatchPage,
  AuditPage,
} from "../features/server/pages";
import { PlayersPage } from "../features/players/players-page";
import { ActionsDialog } from "../features/actions/actions-dialog";
import { ApplicationsPage } from "../features/applications";
import { SupportersPage } from "../features/supporters";
import { CombatPage } from "../features/combat/combat-page";

const pages = {
  overview: ["◫", "Overview", "Server overview", "Keep an eye on the match. Take care of the community."],
  players: ["♟", "Live players", "Live players", "The people in your server, and the tools to look after them."],
  combat: ["⌁", "Combat history", "Combat history", "Recorded kills, player history, and the server leaderboard."],
  whitelist: [
    "☷",
    "Whitelist",
    "Community whitelist",
    "Manage queue access while keeping the current community list intact.",
  ],
  applications: [
    "✉",
    "Applications",
    "Whitelist applications",
    "Review community requests and grant access when they’re ready.",
  ],
  supporters: [
    "✳",
    "Supporters",
    "Community supporters",
    "Match Patreon support to the crew and review future founder benefits.",
  ],
  bans: ["⊘", "Bans", "Server bans", "Review restrictions and keep moderation decisions accountable."],
  announcements: ["↗", "Announcements", "Announcements", "Keep the crew in the loop, directly from your dashboard."],
  match: ["◇", "Match & maps", "Match & maps", "Control the current round using the options this server supports."],
  audit: ["◷", "Action history", "Action history", "Who changed what, why they did it, and what the game confirmed."],
} as const;
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
  const [me, setMe] = useState<Staff | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const expire = useCallback((reason: string) => {
    setMe(null);
    setMessage(reason);
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    configureSession("", expire);
    void api<Staff>("me", { signal: controller.signal })
      .then((staff) => {
        if (controller.signal.aborted) return;
        if (
          !staff ||
          !["admin", "moderator", "viewer"].includes(staff.role) ||
          typeof staff.csrf !== "string" ||
          typeof staff.name !== "string"
        )
          throw new Error("The staff session could not be verified.");
        configureSession(staff.csrf, expire);
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
  return me ? (
    <Dashboard
      key={me.id}
      me={me}
      signOut={() => {
        configureSession("");
        expire("Signed out.");
      }}
    />
  ) : (
    <Login message={message} />
  );
}
function Dashboard({ me, signOut }: { me: Staff; signOut: () => void }) {
  const location = useLocation();
  const key = location.pathname.split("/").filter(Boolean)[0] || "overview";
  const page = Object.hasOwn(pages, key) ? (key as keyof typeof pages) : "overview";
  const gamePage = !["applications", "supporters", "combat"].includes(page);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stale, setStale] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [notice, setNotice] = useState({ message: "", kind: "" });
  const [action, setAction] = useState<{ action: ActionName; steamId?: string; key: string } | null>(null);
  const pause = useRef(false);
  pause.current = busy || dialogOpen;
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const invalidateOverview = useCallback(() => setStale(true), []);
  const notify = useCallback((message: string, kind = "") => setNotice({ message, kind }), []);
  const openAction = useCallback(
    (action: ActionName, steamId?: string) => setAction({ action, steamId, key: crypto.randomUUID() }),
    [],
  );
  useEffect(() => {
    const tick = () => {
      if (!document.hidden && !pause.current) refresh();
    };
    const timer = window.setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);
  useEffect(() => {
    if (!gamePage) return;
    const controller = new AbortController();
    void api<Overview>("overview", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setOverview(value);
          setStale(false);
          setError("");
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStale(true);
          setError(error instanceof Error ? error.message : "The server could not be read.");
        }
      });
    return () => controller.abort();
  }, [gamePage, refreshVersion]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);
  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await api("logout", { method: "POST", body: "{}" });
      signOut();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Sign out failed.", "error");
    } finally {
      setBusy(false);
    }
  }
  const staffPage = (element: React.ReactNode) => (me.role === "admin" ? element : <Navigate to="/overview" replace />);
  return (
    <AdminContext.Provider
      value={{
        me,
        overview,
        stale,
        busy,
        setBusy,
        dialogOpen,
        setDialogOpen,
        refreshVersion,
        refresh,
        invalidateOverview,
        notify,
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
          <p className="nav-label">SERVER OPERATIONS</p>
          <nav aria-label="Dashboard sections">
            {Object.entries(pages)
              .filter(([id]) => me.role === "admin" || !["applications", "supporters"].includes(id))
              .map(([id, item]) => (
                <NavLink
                  key={id}
                  to={`/${id}`}
                  className={({ isActive }) => (isActive ? "active" : "")}
                  onClick={(event) => {
                    if (busy || dialogOpen) event.preventDefault();
                  }}
                >
                  <span>{item[0]}</span>
                  {item[1]}
                </NavLink>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <a className="community" href="https://theuncsgaming.com/">
              ↖ Back to the community<small>Good games. Older knees.</small>
            </a>
            <div className="staff">
              <div className="avatar">{me.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{me.name}</strong>
                <small>{me.role}</small>
              </div>
              <button
                className="icon-button"
                title="Sign out"
                aria-label="Sign out"
                disabled={busy}
                onClick={() => void logout()}
              >
                ↪
              </button>
            </div>
          </div>
        </aside>
        <main id="main-content">
          {me.demo && (
            <div className="demo-banner">
              LOCAL PREVIEW{" "}
              <span>Sample players and simulated actions. This preview cannot control the live server.</span>
            </div>
          )}
          <header className="topbar">
            <div>
              <a className="breadcrumb" href="https://theuncsgaming.com/">
                The UNCs
              </a>
              <span className="divider">/</span>
              <span className="breadcrumb">Admin</span>
              <span className="divider">/</span>
              <span>{pages[page][1]}</span>
            </div>
            <div className="topbar-right">
              {gamePage && (
                <Badge kind={stale ? "warn" : "good"}>
                  {stale ? "Connection needs attention" : "● Server responding"}
                </Badge>
              )}
              <span className="private-label">STAFF ONLY</span>
              <button
                className="icon-button mobile-only"
                title="Sign out"
                aria-label="Sign out"
                disabled={busy}
                onClick={() => void logout()}
              >
                ↪
              </button>
            </div>
          </header>
          <div className="content">
            <div className="page-heading">
              <div>
                <p className="eyebrow">✳ WARDOGS / COMMUNITY SERVER</p>
                <h1>{pages[page][2]}</h1>
                <p>{pages[page][3]}</p>
              </div>
              <button className="button secondary" disabled={busy || dialogOpen} onClick={refresh}>
                ↻ <span>Refresh</span>
              </button>
            </div>
            {gamePage && (
              <div className="server-strip">
                <span className="server-symbol" aria-hidden="true">
                  ✳
                </span>
                <div>
                  <strong>{overview?.status.serverName || "Connecting to the server…"}</strong>
                  <small>
                    {overview
                      ? `${stale ? "Last successful check" : "Last checked"} ${new Date(overview.observedAt).toLocaleTimeString()}`
                      : "Waiting for a response"}
                  </small>
                </div>
                <span className="build">{overview?.capabilities.build}</span>
              </div>
            )}
            {gamePage && error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            {notice.message && (
              <div className={`notice ${notice.kind}`} role="status">
                {notice.message}
              </div>
            )}
            <section id="page" aria-live="polite">
              <Routes>
                <Route index element={<Navigate to="/overview" replace />} />
                <Route path="overview" element={<OverviewPage />} />
                <Route path="players" element={<PlayersPage />} />
                <Route path="whitelist" element={<WhitelistPage />} />
                <Route path="bans" element={<BansPage />} />
                <Route path="announcements" element={<AnnouncementsPage />} />
                <Route path="match" element={<MatchPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="combat" element={<CombatPage />} />
                <Route path="applications" element={staffPage(<ApplicationsPage />)} />
                <Route path="supporters" element={staffPage(<SupportersPage />)} />
                <Route
                  path="*"
                  element={<Empty title="Page not found" detail="Choose a section from the staff menu." />}
                />
              </Routes>
            </section>
            <footer>
              <span>THE UNCs ✳ POWERED BY GRAMPS</span>
              <span>Updates every 20 seconds while this page is visible</span>
            </footer>
          </div>
        </main>
      </div>
      {action && (
        <ActionsDialog
          key={action.key}
          action={action.action}
          steamId={action.steamId}
          onClose={() => setAction(null)}
        />
      )}
    </AdminContext.Provider>
  );
}
