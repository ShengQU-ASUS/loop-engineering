import { AlertTriangle, Check, ChevronRight, CircleAlert, Inbox, LoaderCircle, RotateCcw, ServerOff, X } from "lucide-react";
import { useEffect, useRef, type PropsWithChildren, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiEnvelope } from "./api";
import { titleCase } from "./utils";

export const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

export function Badge({ value, tone }: { value: string; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  const inferred = tone ?? (
    ["succeeded", "passed", "approved", "approve", "verified", "closed", "live", "connected", "finished"].includes(value) ? "good" :
    ["failed", "timed_out", "rejected", "reject", "blocked", "open", "error", "critical", "invalid", "stale"].includes(value) ? "bad" :
    ["waiting", "paused", "capped", "cancelled", "warning", "pending", "delayed", "unverified", "high", "expired", "revoked"].includes(value) ? "warn" :
    ["running", "active", "managed", "L2", "L3"].includes(value) ? "info" : "neutral"
  );
  return <span className={`badge badge-${inferred}`}><span className="badge-dot" aria-hidden="true" />{titleCase(value)}</span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="header-actions">{actions}</div>}
  </header>;
}

export function Panel({ title, description, actions, className, children }: PropsWithChildren<{ title?: string; description?: string; actions?: ReactNode; className?: string }>) {
  return <section className={cx("panel", className)}>
    {(title || actions) && <div className="panel-header"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{actions && <div className="panel-actions">{actions}</div>}</div>}
    {children}
  </section>;
}

export function Metric({ label, value, detail, tone = "neutral", icon }: { label: string; value: string | number; detail: string; tone?: string; icon: ReactNode }) {
  return <div className={`metric metric-${tone}`}><div className="metric-icon" aria-hidden="true">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

export function Progress({ value, label, warnAt = 80 }: { value: number; label?: string; warnAt?: number }) {
  const tone = value >= 100 ? "bad" : value >= warnAt ? "warn" : "good";
  return <div className="progress-wrap">{label && <div className="progress-label"><span>{label}</span><strong>{value}%</strong></div>}<div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${value}%`} aria-label={label ?? "Progress"}><span className={`progress-${tone}`} style={{ width: `${Math.min(value, 100)}%` }} /></div></div>;
}

export function EmptyState({ title = "Nothing here yet", detail = "Records will appear when the control plane reports them." }: { title?: string; detail?: string }) {
  return <div className="state-block"><Inbox aria-hidden="true" /><strong>{title}</strong><p>{detail}</p></div>;
}

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return <div className="loading-block" role="status" aria-label="Loading"><div className="loading-heading"><LoaderCircle className="spin" /> Loading live state</div>{Array.from({ length: rows }).map((_, index) => <div className="skeleton" key={index} style={{ width: `${96 - index * 7}%` }} />)}</div>;
}

export function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="state-block state-error" role="alert"><ServerOff aria-hidden="true" /><strong>Could not load this view</strong><p>{error.message}</p><button className="button button-secondary" onClick={retry}><RotateCcw size={16} /> Retry</button></div>;
}

export function QueryState<T>({ query, children }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown; data?: ApiEnvelope<T> }; children: (data: T, source: ApiEnvelope<T>) => ReactNode }) {
  if (query.isPending) return <LoadingState />;
  if (query.error && !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <EmptyState />;
  return <>
    {query.error && <div className="stale-data-notice" role="status"><AlertTriangle size={16} aria-hidden="true" /><span><strong>Live refresh failed.</strong> Showing the last known state. {query.error.message}</span><button className="button button-secondary" onClick={() => void query.refetch()}><RotateCcw size={14} /> Retry</button></div>}
    {children(query.data.data, query.data)}
  </>;
}

export function DemoNotice({ source }: { source: ApiEnvelope<unknown> }) {
  if (source.source !== "demo") return null;
  return <div className="demo-notice" role="status"><CircleAlert size={16} /><span><strong>Demo data</strong> — the local API is unavailable. No controls will change real runs.</span></div>;
}

export function TableWrap({ label, children }: PropsWithChildren<{ label: string }>) {
  return <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function RunLink({ id, children }: PropsWithChildren<{ id: string }>) {
  return <Link className="row-link" to={`/runs/${id}`}>{children}<ChevronRight size={15} aria-hidden="true" /></Link>;
}

export function Modal({ title, description, open, onClose, children }: PropsWithChildren<{ title: string; description?: string; open: boolean; onClose: () => void }>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? []);
    if (!dialogRef.current?.contains(document.activeElement)) focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]; const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); restoreFocusRef.current?.focus(); };
  }, [open]);
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={description ? "modal-description" : undefined}>
      <div className="modal-header"><div><h2 id="modal-title">{title}</h2>{description && <p id="modal-description">{description}</p>}</div><button className="icon-button" title="Close" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
      {children}
    </div>
  </div>;
}

export function Callout({ tone, title, children }: PropsWithChildren<{ tone: "warn" | "bad" | "good" | "info"; title: string }>) {
  const Icon = tone === "good" ? Check : tone === "bad" ? AlertTriangle : CircleAlert;
  return <div className={`callout callout-${tone}`}><Icon size={18} aria-hidden="true" /><div><strong>{title}</strong><div>{children}</div></div></div>;
}
