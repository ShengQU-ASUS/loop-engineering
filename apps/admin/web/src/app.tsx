import { useState } from "react";
import { Activity, Archive, Bot, Boxes, CircleGauge, FileCheck2, Menu, Network, ScrollText, Settings2, ShieldCheck, X } from "lucide-react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useApiQuery } from "./api";
import { Badge, cx } from "./components";
import { AgentsPage, ApprovalsPage, ArtifactsPage, AuditPage, LoopsPage, OverviewPage, PoliciesPage, RunsPage } from "./pages";
import { RunDetailPage } from "./run-detail";
import type { OverviewResponse, Session } from "./types";

const nav = [
  { to: "/", label: "Overview", icon: CircleGauge, end: true },
  { to: "/loops", label: "Loops", icon: Network },
  { to: "/runs", label: "Runs", icon: Activity },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/agents", label: "Agents & Worktrees", icon: Bot },
  { to: "/artifacts", label: "Artifacts", icon: Archive },
  { to: "/policies", label: "Policies & Budgets", icon: Settings2 },
  { to: "/audit", label: "Audit", icon: ScrollText },
];

function Brand() {
  return <div className="brand"><div className="brand-mark"><Boxes size={19} aria-hidden="true" /></div><div><strong>Loop Engineering</strong><span>Admin control plane</span></div></div>;
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useApiQuery<Session>("/session");
  const overview = useApiQuery<OverviewResponse>("/overview", { refetchInterval: 5000 });
  const user = typeof session.data?.data.user === "string" ? session.data.data.user : session.data?.data.user.name ?? "Local admin";
  const connectionStatus = overview.data?.data.connection.status ?? (overview.error ? "offline" : "connecting");
  return <>
    {open && <button className="nav-scrim" aria-label="Close navigation" onClick={onClose} />}
    <aside className={cx("sidebar", open && "sidebar-open")} aria-label="Primary navigation">
      <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" title="Close menu" aria-label="Close menu" onClick={onClose}><X size={18} /></button></div>
      <nav>{nav.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} onClick={onClose} className={({ isActive }) => cx("nav-item", isActive && "nav-active")}><Icon size={18} aria-hidden="true" /><span>{label}</span>{label === "Approvals" && Boolean(overview.data?.data.counts.pendingApprovals) && <span className="nav-count">{overview.data?.data.counts.pendingApprovals}</span>}</NavLink>)}</nav>
      <div className="sidebar-foot">
        <div className="connection"><span className={cx("connection-dot", connectionStatus !== "connected" && `connection-${connectionStatus}`)} /><div><strong>{connectionStatus === "connected" ? "Control plane connected" : connectionStatus === "offline" ? "Control plane offline" : "Connecting to control plane"}</strong><span>127.0.0.1 · SQLite</span></div></div>
        <div className="identity"><div className="avatar">{user.slice(0, 2).toUpperCase()}</div><div><strong>{user}</strong><span>{session.data?.data.role ?? "admin"}</span></div><Badge value={session.data?.data.role ?? "admin"} /></div>
      </div>
    </aside>
  </>;
}

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const overview = useApiQuery<OverviewResponse>("/overview", { refetchInterval: 5000 });
  const mobileStatus = overview.data?.data.connection.status ?? (overview.error ? "offline" : "connecting");
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
    <div className="main-column">
      <header className="mobile-header"><button className="icon-button" title="Open menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><Brand /><div className={cx("live-pill", mobileStatus !== "connected" && "live-pill-offline")}><span /> {mobileStatus === "connected" ? "Live" : mobileStatus}</div></header>
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/loops" element={<LoopsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/policies" element={<PoliciesPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="app-footer"><FileCheck2 size={14} /> Observable facts only · Hidden reasoning is never displayed</footer>
    </div>
  </div>;
}
