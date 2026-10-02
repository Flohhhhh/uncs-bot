import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useAdmin, useGameAdmin } from "../app/context";
import type { ActionName, ActionResult } from "../api/types";
import { allowed } from "../features/actions/policy";
export function Badge({ children, kind = "neutral" }: { children: ReactNode; kind?: string }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
/** One wording for every recorded action outcome; "started" is a receipt that never finished. */
export type OutcomeState = ActionResult["state"] | "started";
export const outcomeLabels: Record<OutcomeState, string> = {
  applied: "Applied",
  accepted: "Accepted · not verified",
  pending: "Pending",
  failed: "Failed",
  unknown: "Unconfirmed",
  started: "Unconfirmed",
};
export function OutcomeBadge({ state }: { state: OutcomeState }) {
  // An unexpected value from the server is never shown as a success.
  const known = Object.hasOwn(outcomeLabels, state);
  return (
    <Badge kind={known && state === "applied" ? "good" : state === "failed" ? "bad" : "warn"}>
      {known ? outcomeLabels[state] : outcomeLabels.unknown}
    </Badge>
  );
}
export function Empty({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
/** Opens the action's review; disabled unless the action is allowed for this role, connection and build. */
export function ActionButton({
  action,
  steamId,
  children,
  kind = "secondary small",
  disabled = false,
}: {
  action: ActionName;
  steamId?: string;
  children: ReactNode;
  kind?: string;
  disabled?: boolean;
}) {
  const { me, overview, stale, busy, openAction } = useGameAdmin();
  return (
    <button
      className={`button ${kind}`}
      disabled={disabled || !allowed(action, me, overview, stale, busy)}
      onClick={() => openAction(action, steamId)}
    >
      {children}
    </button>
  );
}
export type TabOption<T extends string = string> = { id: T; label: ReactNode; disabled?: boolean };
export type TabsProps<T extends string> = {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabOption<T>[];
  /** Keep the selected tab in this search parameter, such as "view". Other parameters, including `server`, are kept. */
  param?: string;
  /** The selected tab, when the caller holds the selection instead of the URL. */
  value?: T;
  /** Used when the URL or `value` names no available tab. Defaults to the first enabled tab. */
  defaultValue?: T;
  /** Called when staff choose a different tab. */
  onChange?: (id: T) => void;
  /** Renders the selected tab's panel. */
  children?: (selected: T) => ReactNode;
  className?: string;
};
/** Reads and writes one tab choice in the URL, keeping the other search parameters. */
export function useTabParam<T extends string>(param: string, ids: readonly T[], fallback: T): [T, (id: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const value = raw !== null && (ids as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const select = useCallback(
    (id: T) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set(param, id);
          return next;
        },
        { replace: true },
      ),
    [param, setParams],
  );
  return [value, select];
}
function fallbackTab<T extends string>(tabs: readonly TabOption<T>[], preferred?: T) {
  const enabled = tabs.filter((tab) => !tab.disabled);
  return (enabled.find((tab) => tab.id === preferred) ?? enabled[0] ?? tabs[0]).id;
}
/**
 * Accessible tabs. Arrow keys, Home and End move between tabs; Enter, Space or a click selects one.
 * With `param` the choice lives in the URL; otherwise it uses `value` or its own state.
 * A disabled tab cannot be chosen, but stays shown if the URL or `value` already selects it.
 */
export function Tabs<T extends string>(props: TabsProps<T>) {
  if (!props.tabs.length) return null;
  return props.param ? <UrlTabs {...props} param={props.param} /> : <LocalTabs {...props} />;
}
function UrlTabs<T extends string>(props: TabsProps<T> & { param: string }) {
  const ids = props.tabs.map((tab) => tab.id);
  const [selected, select] = useTabParam(props.param, ids, fallbackTab(props.tabs, props.defaultValue));
  return (
    <TabStrip
      {...props}
      selected={selected}
      select={(id) => {
        select(id);
        props.onChange?.(id);
      }}
    />
  );
}
function LocalTabs<T extends string>(props: TabsProps<T>) {
  const [own, setOwn] = useState(props.defaultValue);
  const wanted = props.value ?? own;
  const selected = props.tabs.some((tab) => tab.id === wanted) ? wanted! : fallbackTab(props.tabs, props.defaultValue);
  return (
    <TabStrip
      {...props}
      selected={selected}
      select={(id) => {
        if (props.value === undefined) setOwn(id);
        props.onChange?.(id);
      }}
    />
  );
}
function TabStrip<T extends string>({
  label,
  tabs,
  selected,
  select,
  children,
  className = "",
}: TabsProps<T> & { selected: T; select: (id: T) => void }) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const selectedIndex = tabs.findIndex((tab) => tab.id === selected);
  // Keep one tab reachable with Tab even while the selected one is disabled.
  const entry = tabs[selectedIndex]?.disabled ? fallbackTab(tabs) : selected;
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (Math.max(current, 0) + step + buttons.length) % buttons.length;
    buttons[index].focus();
  }
  return (
    <>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className={`settings-tabs ${className}`.trim()}
        onKeyDown={move}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${index}`}
            className="button secondary"
            aria-selected={tab.id === selected}
            aria-controls={children ? `${base}-panel` : undefined}
            tabIndex={tab.id === entry ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => {
              if (tab.id !== selected) select(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children && (
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${selectedIndex}`}>
          {children(selected)}
        </div>
      )}
    </>
  );
}
export function Metric({
  label,
  value,
  note,
  word = false,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  word?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <span>↗</span>
      </div>
      <div className={`metric-value ${word ? "word" : ""}`}>{value}</div>
      <div className="metric-note">{note}</div>
    </div>
  );
}
export function Card({
  title,
  subtitle,
  badge,
  children,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      <div className="card-header">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}
export function Search({
  value,
  onChange,
  placeholder,
  children,
  clearLabel = "Clear search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  children?: ReactNode;
  clearLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const compactClear = clearLabel === "Clear search";
  const clearButton = value && (
    <button
      type="button"
      className={compactClear ? "icon-button search-clear" : "button secondary"}
      aria-label={clearLabel}
      title={clearLabel}
      onClick={() => {
        onChange("");
        input.current?.focus();
      }}
    >
      {compactClear ? "×" : clearLabel}
    </button>
  );
  return (
    <div className="toolbar">
      <div className="search">
        <input
          type="search"
          ref={input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {compactClear && clearButton}
      </div>
      {!compactClear && clearButton}
      {children}
    </div>
  );
}
export function ReasonField({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <label>
      Reason
      <textarea
        name="reason"
        required
        minLength={3}
        maxLength={200}
        rows={2}
        defaultValue={defaultValue}
        placeholder="A clear reason for the staff record"
      />
    </label>
  );
}
export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
  className = "",
  serverScoped = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  serverScoped?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { setDialogOpen, server } = useAdmin();
  useEffect(() => {
    setDialogOpen(true);
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      setDialogOpen(false);
    };
  }, [setDialogOpen]);
  return (
    <dialog
      ref={dialog}
      className={className}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-top">
        <p className="eyebrow">STAFF REVIEW</p>
        <button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      <h2 id="dialog-title">{title}</h2>
      {serverScoped && server && (
        <p className="server-review-target">
          Game server: <strong>{server.name}</strong> <small>({server.id})</small>
        </p>
      )}
      {description && <p className="muted">{description}</p>}
      {children}
    </dialog>
  );
}
/**
 * A side drawer on wide screens and a bottom sheet on phones. Focus moves into the sheet and
 * returns when it closes; Escape closes it. It does not pause refreshes, so its links still work.
 */
export function Sheet({
  title,
  description,
  children,
  onClose,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = sheet.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    if (element && !element.contains(document.activeElement)) element.focus();
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={sheet}
      className={`sheet ${className}`.trim()}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        // A review opened inside the sheet handles its own Escape.
        if (event.key !== "Escape" || (event.target as Element).closest("dialog") !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="sheet-top">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      {description && <p className="muted">{description}</p>}
      {children}
    </dialog>
  );
}
export function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export type TableHeader = string | { label: string; sort: "none" | "ascending" | "descending"; onSort: () => void };
export function Table({
  headers,
  children,
  label,
  scrollable = false,
}: {
  headers: TableHeader[];
  children: ReactNode;
  label?: string;
  scrollable?: boolean;
}) {
  return (
    <div
      className={`table-wrap${scrollable ? " scrollable" : ""}`}
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? "region" : undefined}
      aria-label={scrollable ? `${label} scroll area` : undefined}
    >
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th key={index} scope="col" aria-sort={typeof header === "string" ? undefined : header.sort}>
                {typeof header === "string" ? (
                  header || <span className="sr-only">Actions</span>
                ) : (
                  <button
                    type="button"
                    className="table-sort"
                    onClick={header.onSort}
                    aria-label={`Sort by ${header.label}`}
                  >
                    {header.label}
                    <span aria-hidden="true">
                      {header.sort === "ascending" ? "↑" : header.sort === "descending" ? "↓" : "↕"}
                    </span>
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
