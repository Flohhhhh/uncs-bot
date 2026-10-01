import { useEffect, useRef, type ReactNode } from "react";
import { useAdmin } from "../app/context";
export function Badge({ children, kind = "neutral" }: { children: ReactNode; kind?: string }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty">
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  children?: ReactNode;
}) {
  return (
    <div className="toolbar">
      <label className="search">
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </label>
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
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { setDialogOpen } = useAdmin();
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
      {description && <p className="muted">{description}</p>}
      {children}
    </dialog>
  );
}
export function date(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
