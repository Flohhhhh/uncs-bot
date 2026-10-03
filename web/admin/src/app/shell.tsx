import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { Overview, Staff } from "../api/types";
import { ServerLink } from "./server-link";

/**
 * The one connection status in the dashboard. It names the time of the last successful check;
 * a stale snapshot offers a retry. The hidden status line announces only changes of state.
 */
export function StatusPill({
  overview,
  stale,
  error,
  disabled,
  retry,
}: {
  overview: Overview | null;
  stale: boolean;
  error: string;
  disabled: boolean;
  retry: () => void;
}) {
  const announcement = overview && stale ? "Server details need a fresh check. Refresh before making changes." : "";
  const live = (
    <span className="sr-only" role="status">
      {announcement}
    </span>
  );
  if (!overview)
    return (
      <span className={`status-pill ${error ? "bad" : "neutral"}`}>
        <span className="status-dot" aria-hidden="true" />
        {error ? "Not connected" : "Connecting…"}
        {live}
      </span>
    );
  const checked = new Date(overview.observedAt).toLocaleTimeString();
  const tip = `${overview.status.serverName || "Game server"} · Updates every 20 seconds while visible`;
  return (
    <span className={`status-pill ${stale ? "warn" : "good"}`} title={tip}>
      <span className="status-dot" aria-hidden="true" />
      <span>
        {stale ? "Stale" : "Live"}
        <span className="status-time">
          {" "}
          · <span className="status-checked">checked </span>
          {checked}
        </span>
      </span>
      {stale && !error && (
        <button type="button" className="status-retry" disabled={disabled} onClick={retry}>
          Retry
        </button>
      )}
      {live}
    </span>
  );
}

/** Who is signed in, their access on this server, the game build and sign-out. */
export function AccountDetails({
  me,
  role,
  build,
  disabled,
  signOut,
  onNavigate,
}: {
  me: Staff;
  role: Staff["role"];
  build?: string;
  disabled: boolean;
  signOut: () => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="account-details">
      <p className="account-who">
        <strong>{me.name}</strong>
        <span>
          Your access: {role} ·{" "}
          <ServerLink
            className="text-link"
            to="/permissions"
            onClick={(event) => {
              if (disabled) event.preventDefault();
              else onNavigate?.();
            }}
          >
            View permissions
          </ServerLink>
        </span>
      </p>
      {build && (
        <p className="account-build">
          Game build <code>{build}</code>
        </p>
      )}
      <a className="account-community" href="https://theuncsgaming.com/">
        ↖ Back to the community
      </a>
      <button type="button" className="button secondary small" disabled={disabled} onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}

/** The account button in the header. Escape, an outside click or navigation closes it. */
export function AccountMenu({
  me,
  role,
  build,
  disabled,
  signOut,
}: {
  me: Staff;
  role: Staff["role"];
  build?: string;
  disabled: boolean;
  signOut: () => void;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const expanded = open && !disabled;
  useEffect(() => setOpen(false), [location.pathname, location.search, disabled]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);
  return (
    <div ref={container} className="account-menu">
      <button
        ref={button}
        type="button"
        className="account-button"
        aria-expanded={expanded}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen(!expanded)}
      >
        <span className="avatar" aria-hidden="true">
          {me.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="account-name">
          <span className="sr-only">Account:</span> {me.name}
        </span>
        <span className="account-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <div id={id} className="account-panel" hidden={!expanded}>
        <AccountDetails
          me={me}
          role={role}
          build={build}
          disabled={disabled}
          onNavigate={() => setOpen(false)}
          signOut={() => {
            setOpen(false);
            signOut();
          }}
        />
      </div>
    </div>
  );
}
