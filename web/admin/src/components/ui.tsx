import {
  Children,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
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
export function Empty({
  title,
  detail,
  action,
  alert = false,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  alert?: boolean;
}) {
  // Only a failed read is announced, so routine loading and refreshes stay quiet. The key mounts the
  // alert as a new element, which screen readers announce more reliably than a role added in place.
  return (
    <div className="empty" role={alert ? "alert" : undefined} key={alert ? "alert" : "empty"}>
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
      <div ref={list} role="tablist" aria-label={label} className={`tabs ${className}`.trim()} onKeyDown={move}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${index}`}
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
        <div
          role="tabpanel"
          id={`${base}-panel`}
          className="tab-panel"
          aria-labelledby={`${base}-tab-${selectedIndex}`}
        >
          {children(selected)}
        </div>
      )}
    </>
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
export function CountedTextarea({
  label,
  limit = 200,
  defaultValue = "",
  ...textarea
}: { label: ReactNode; limit?: number; defaultValue?: string } & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "defaultValue" | "maxLength" | "value"
>) {
  // No maxLength: browsers silently cut pasted text to fit it. Count instead, and let the form's own
  // length check refuse an over-long value with a visible error.
  const id = useId();
  const [length, setLength] = useState(() => defaultValue.trim().length);
  const over = length > limit;
  return (
    <>
      <label>
        {label}
        <textarea
          {...textarea}
          defaultValue={defaultValue}
          aria-describedby={id}
          aria-invalid={over || undefined}
          onChange={(event) => setLength(event.target.value.trim().length)}
        />
      </label>
      <small id={id} className={`character-count${over ? " over" : ""}`}>
        {length}/{limit}
        {over && ` · ${length - limit} over the limit`}
      </small>
    </>
  );
}
export function ReasonField({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <CountedTextarea
      label="Reason"
      name="reason"
      required
      minLength={3}
      rows={2}
      defaultValue={defaultValue}
      placeholder="A clear reason for the staff record"
    />
  );
}
/**
 * Where focus goes when the control that opened a dialog cannot take it back. A review opened from the
 * player panel returns to the panel, which stays open behind it and keeps the page inert; otherwise the
 * page heading takes focus rather than leave keyboard users at the end of the page.
 */
function focusPageHeading() {
  const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  const panel = open[open.length - 1];
  if (panel) {
    panel.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>("#main-content h1[tabindex]");
  (heading ?? document.getElementById("main-content"))?.focus();
}
export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
  className = "",
  serverScoped = false,
  eyebrow = "STAFF REVIEW",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  serverScoped?: boolean;
  /** The small label above the title. Pass null on result screens, which are no longer a review. */
  eyebrow?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  const { setDialogOpen, server } = useAdmin();
  useLayoutEffect(() => {
    setDialogOpen(true);
    const element = dialog.current;
    const opener = document.activeElement;
    // Some close requests close the dialog natively whatever the cancel handler does, such as the Android back
    // gesture. Reopen a busy dialog so its progress and Stop control stay reachable; otherwise let the parent
    // remove it. The listener goes before this cleanup's own close().
    const closed = () => {
      if (!element?.isConnected || element.open) return;
      if (latest.current.busy) element.showModal();
      else latest.current.onClose();
    };
    element?.addEventListener("close", closed);
    element?.showModal();
    return () => {
      element?.removeEventListener("close", closed);
      // A layout cleanup runs before React removes the dialog, so close() still returns focus to the control
      // that opened it. When that control is gone or disabled by now (a removed row, a deselected bulk move),
      // focus the page heading rather than leave keyboard users at the end of the page.
      element?.close();
      setDialogOpen(false);
      if (document.activeElement !== opener) focusPageHeading();
    };
  }, [setDialogOpen]);
  useEffect(() => {
    const element = dialog.current;
    if (!busy || !element) return;
    // Chrome lets a page cancel only the first Escape after a click; the next one closes the dialog anyway.
    // While busy, stop the key before it becomes a close request. Focus can be on the page body here, once
    // the button that started the work is gone, so listen on the document.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", escape, true);
    element.setAttribute("closedby", "none");
    return () => {
      document.removeEventListener("keydown", escape, true);
      element.removeAttribute("closedby");
    };
  }, [busy]);
  return (
    <dialog
      ref={dialog}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-top">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      <h2 id={titleId}>{title}</h2>
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
  const descriptionId = useId();
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  // A layout effect, like Modal's. A sheet that closes as a review opens in the same update, such as a pick in the
  // player picker or Sign out with unsaved drafts in More, then closes before React removes it and before the
  // review calls showModal(). Focus goes back to the sheet's opener, which the review then records as its own.
  useLayoutEffect(() => {
    const element = sheet.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Some close requests close the sheet natively whatever the cancel handler does, such as the Android back
    // gesture. Let the parent remove it too, so the panel is not left closed but still mounted.
    const closed = () => {
      if (element?.isConnected && !element.open) latestClose.current();
    };
    element?.addEventListener("close", closed);
    element?.showModal();
    if (element && !element.contains(document.activeElement)) element.focus();
    return () => {
      element?.removeEventListener("close", closed);
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus();
      // A review still open over the sheet keeps focus on its own controls.
      if (document.activeElement?.closest("dialog[open]")) return;
      // The control that opened the panel can be gone by now, such as a player who left the roster.
      if (!previous || document.activeElement !== previous) focusPageHeading();
    };
  }, []);
  return (
    <dialog
      ref={sheet}
      className={`sheet ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
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
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && (
            <p id={descriptionId} className="muted">
              {description}
            </p>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="Close panel" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </dialog>
  );
}
export function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export type TableHeader =
  | string
  /** A heading only screen readers hear, such as a selection column. */
  | { label: string; hidden: true }
  | { label: string; sort: "none" | "ascending" | "descending"; onSort: () => void };
/** Rows above this count scroll inside the table on wide screens instead of lengthening the page. */
export const scrollRowLimit = 25;
export function Table({
  headers,
  children,
  label,
  scrollable = false,
  cards = false,
}: {
  headers: TableHeader[];
  children: ReactNode;
  label?: string;
  /** Allow an inner scroller; it applies only above `scrollRowLimit` rows. */
  scrollable?: boolean;
  /** On phones, show each row as a card that labels its cells with the column headers. */
  cards?: boolean;
}) {
  const scrolls = scrollable && Children.count(children) > scrollRowLimit;
  // CSS reads each column's label from these variables; JSON quoting is valid CSS string syntax.
  const labels = cards
    ? Object.fromEntries(
        headers.map((header, index) => [
          `--cell-label-${index + 1}`,
          JSON.stringify(typeof header === "string" ? header : header.label),
        ]),
      )
    : undefined;
  return (
    <div
      className={`table-wrap${scrolls ? " scrollable" : ""}`}
      data-mobile={cards ? "cards" : undefined}
      style={labels as CSSProperties | undefined}
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? `${label} scroll area` : undefined}
    >
      <table aria-label={label}>
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                aria-sort={typeof header === "object" && "sort" in header ? header.sort : undefined}
              >
                {typeof header === "string" ? (
                  header || <span className="sr-only">Actions</span>
                ) : "hidden" in header ? (
                  <span className="sr-only">{header.label}</span>
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
