import { useEffect, useRef, type ReactNode } from "react";
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
