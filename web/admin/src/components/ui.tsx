import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { useAdmin } from "../app/context";
export function Badge({ children, kind = "neutral" }: { children: ReactNode; kind?: string }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
export function Empty({ title, detail, alert = false }: { title: string; detail?: string; alert?: boolean }) {
  // Only a failed read is announced, so routine loading and refreshes stay quiet. The key mounts the
  // alert as a new element, which screen readers announce more reliably than a role added in place.
  return (
    <div className="empty" role={alert ? "alert" : undefined} key={alert ? "alert" : "empty"}>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
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
function focusPageHeading() {
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
    const escape = (event: KeyboardEvent) => {
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
