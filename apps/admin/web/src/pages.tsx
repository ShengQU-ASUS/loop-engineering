import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowDownToLine, Bot, CheckCircle2, CirclePause, CirclePlay, Clipboard, Clock3, Cpu, FileDiff, GitBranch, KeyRound, ListFilter, LockKeyhole, Play, Radio, Search, ShieldCheck, TimerReset, Users, XCircle, Zap } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useGlobalPauseState, useSessionAccess } from "./access";
import { apiMutation, useApiQuery } from "./api";
import { Badge, Callout, DemoNotice, EmptyState, Metric, Modal, PageHeader, Panel, Progress, QueryState, RunLink, TableWrap } from "./components";
import { NewRunButton } from "./new-run";
import type { AgentRecord, ApprovalRecord, ArtifactRecord, AuditRecord, GlobalPauseState, LoopDefinition, OverviewResponse, RunRecord, WorktreeRecord } from "./types";
import { bytes, compactId, percent, relativeTime, shortDate, titleCase } from "./utils";

function ConnectionStrip({ data }: { data: OverviewResponse }) {
  return <div className="connection-strip"><div><Radio size={16} /><Badge value={data.connection.status} /><span>{data.connection.mode === "managed" ? "Runtime telemetry" : "Read-only snapshot"}</span></div><div><span>Last event {relativeTime(data.connection.lastEventAt)}</span><span className="divider" />{data.connection.globalPause ? <Badge value="Global pause" tone="bad" /> : <span className="quiet"><Play size={14} /> Dispatch enabled</span>}</div></div>;
}

function GlobalPauseControl({ disabled = false }: { disabled?: boolean }) {
  const { query, state } = useGlobalPauseState();
  const access = useSessionAccess();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (reason: string) => apiMutation<GlobalPauseState>("/settings/global-pause", {
      paused: !state?.paused,
      reason,
      expectedVersion: state?.version,
    }, "PATCH"),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["api", "/settings/global-pause"] }),
        client.invalidateQueries({ queryKey: ["api", "/overview"] }),
      ]);
      setOpen(false);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate(String(new FormData(event.currentTarget).get("reason")));
  };
  const paused = state?.paused ?? false;
  const label = paused ? "Resume dispatch" : "Pause dispatch";
  const Icon = paused ? CirclePlay : CirclePause;
  const unavailableReason = disabled ? "Connect the local API to control workspace dispatch"
    : !access.ready ? "Waiting for the local session"
    : !access.canOperate ? "Operator role required to control workspace dispatch"
    : query.isPending ? "Loading workspace dispatch state"
    : query.error ? "Workspace dispatch state is unavailable"
    : undefined;
  return <>
    <button className={paused ? "button button-primary" : "button button-secondary"} disabled={Boolean(unavailableReason)} onClick={() => setOpen(true)} title={unavailableReason ?? label}><Icon size={16} /> {label}</button>
    <Modal open={open} onClose={() => setOpen(false)} title={paused ? "Resume workspace dispatch" : "Pause workspace dispatch"} description="This workspace-wide control is versioned and appended to the audit ledger.">
      <form className="form" onSubmit={submit}>
        <Callout tone={paused ? "info" : "warn"} title={paused ? "Resume bounded execution" : "Stop new execution"}>{paused ? "Queued and paused runs may be started again after this change." : "New runs, starts, and resumes will be rejected until dispatch is resumed. Running processes are not killed."}</Callout>
        <label className="field field-wide"><span>Required reason</span><textarea name="reason" required minLength={4} rows={4} autoFocus placeholder={paused ? "What changed so dispatch can resume?" : "Why must new execution stop?"} /></label>
        {state && <div className="pause-history">Last changed by <strong>{state.changedBy}</strong> {relativeTime(state.changedAt)}: {state.reason}</div>}
        {mutation.error && <div className="form-error" role="alert">{mutation.error.message}</div>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Cancel</button><button className={paused ? "button button-primary" : "button button-danger"} disabled={mutation.isPending}>{mutation.isPending ? "Applying..." : label}</button></div>
      </form>
    </Modal>
  </>;
}

export function OverviewPage() {
  const query = useApiQuery<OverviewResponse>("/overview", { refetchInterval: 5000 });
  return <>
    <QueryState query={query}>{(data, envelope) => <>
      <PageHeader eyebrow="Workspace" title="Operational overview" description="Live, evidence-backed state across every engineering loop." actions={<><GlobalPauseControl disabled={envelope.source === "demo"} /><NewRunButton loops={data.loops} disabled={envelope.source === "demo" || data.connection.globalPause} disabledReason={data.connection.globalPause ? "Resume workspace dispatch before creating a run" : undefined} /></>} />
      <DemoNotice source={envelope} />
      <ConnectionStrip data={data} />
      <div className="metric-grid">
        <Metric label="Active runs" value={data.counts.activeRuns} detail="Executing now" icon={<Activity />} tone="info" />
        <Metric label="Waiting" value={data.counts.waitingRuns} detail="Needs input or event" icon={<Clock3 />} tone="warn" />
        <Metric label="Approvals" value={data.counts.pendingApprovals} detail="Operator decisions" icon={<ShieldCheck />} tone="warn" />
        <Metric label="Open breakers" value={data.counts.openBreakers} detail="Execution stopped" icon={<Zap />} tone="bad" />
        <Metric label="Stale agents" value={data.counts.staleAgents} detail="Heartbeat overdue" icon={<Bot />} tone="bad" />
        <Metric label="Success rate" value={data.metrics?.successRatePct === null || data.metrics?.successRatePct === undefined ? "—" : `${data.metrics.successRatePct}%`} detail={`${data.metrics?.succeededRuns ?? 0}/${data.metrics?.terminalRuns ?? 0} terminal runs`} icon={<CheckCircle2 />} tone={data.metrics?.successRatePct === null ? "neutral" : "good"} />
      </div>
      <div className="overview-grid">
        <Panel title="Needs attention" description="Highest-impact items first" actions={<Link className="text-link" to="/approvals">Review queue</Link>}>
          {!data.attention.length ? <EmptyState title="Nothing needs attention" detail="Breakers, approvals, and stale telemetry will appear here." /> : <div className="attention-list">{data.attention.map((item) => <Link to={item.runId ? `/runs/${item.runId}` : "/"} key={item.id} className="attention-item"><div className={`attention-icon attention-${item.severity}`}>{item.severity === "critical" ? <AlertTriangle size={17} /> : <Clock3 size={17} />}</div><div><strong>{item.title}</strong><p>{item.detail}</p><small>{titleCase(item.kind)} · {relativeTime(item.createdAt)}</small></div><Badge value={item.severity} /></Link>)}</div>}
        </Panel>
        <Panel title="Loop readiness" description="Policy coverage before autonomy" actions={<Link className="text-link" to="/loops">All loops</Link>}>
          <div className="readiness-list">{data.loops.slice(0, 4).map((loop) => <div className="readiness-row" key={loop.id}><div><strong>{loop.name}</strong><span><Badge value={loop.automationLevel} /> {loop.owner}</span></div><Progress value={loop.readinessScore} /></div>)}</div>
        </Panel>
      </div>
      <Panel title="Active runs" description="Current stage and verifiable state, ordered by attention">
        {!data.activeRuns.length ? <EmptyState title="No active runs" detail="Create a run or wait for the next scheduled loop." /> : <TableWrap label="Active runs"><table><thead><tr><th>Run</th><th>Status</th><th>Current stage</th><th>Budget</th><th>Telemetry</th><th aria-label="Open" /></tr></thead><tbody>{data.activeRuns.map((run) => <RunRow run={run} key={run.id} />)}</tbody></table></TableWrap>}
      </Panel>
      <Panel title="Recent observable activity" description="Public tool, state, verification, and human events. Hidden reasoning is excluded.">
        <div className="event-list compact">{data.recentEvents.slice(0, 6).map((event) => <div className="event-row" key={event.id}><span className={`event-mark event-${event.severity}`} /><time>{relativeTime(event.occurredAt)}</time><div><strong>{event.message}</strong><span>{event.actor} · {titleCase(event.provenance)} · #{event.sequence}</span></div><Badge value={event.type} tone="neutral" /></div>)}</div>
      </Panel>
    </>}</QueryState>
  </>;
}

function RunRow({ run }: { run: RunRecord }) {
  const budgetUsed = Math.max(percent(run.budget.tokensUsed, run.budget.tokenLimit), percent(run.budget.iterationsUsed, run.budget.iterationLimit));
  return <tr><td><RunLink id={run.id}><div className="primary-cell"><strong>{run.goal}</strong><span>{run.loopName} · {run.id}</span></div></RunLink></td><td><Badge value={run.status} /></td><td><div className="stack-cell"><strong>{runStageLabel(run)}</strong>{run.waitingReason && <span>{run.waitingReason}</span>}</div></td><td><div className="table-progress"><Progress value={budgetUsed} /><span>{run.budget.iterationsUsed}/{run.budget.iterationLimit} attempts</span></div></td><td><div className="stack-cell"><Badge value={run.freshness} /><span>{relativeTime(run.lastEventAt)}</span></div></td><td><RunLink id={run.id}><span className="sr-only">Open {run.id}</span></RunLink></td></tr>;
}

function runStageLabel(run: RunRecord): string {
  if (run.currentStageName) return run.currentStageName;
  if (run.status === "queued") return "Not started";
  if (run.status === "succeeded") return "All stages passed";
  if (["failed", "timed_out", "cancelled", "capped"].includes(run.status)) return "Run ended";
  return "Awaiting stage telemetry";
}

export function LoopsPage() {
  const query = useApiQuery<LoopDefinition[]>("/loops");
  return <QueryState query={query}>{(loops, envelope) => <>
    <PageHeader eyebrow="Definitions" title="Loops" description="Reusable engineering contracts with explicit owners, policies, budgets, and autonomy." actions={<NewRunButton loops={loops} disabled={envelope.source === "demo"} />} />
    <DemoNotice source={envelope} />
    <div className="summary-line"><span><strong>{loops.filter((loop) => loop.enabled).length}</strong> enabled</span><span><strong>{loops.filter((loop) => loop.schedule).length}</strong> scheduled</span><span><strong>{loops.filter((loop) => loop.readinessScore < 80).length}</strong> below readiness target</span></div>
    <Panel>
      {!loops.length ? <EmptyState title="No loop definitions" detail="Add a LOOP.md definition to register a reusable engineering workflow." /> : <TableWrap label="Loop definitions"><table><thead><tr><th>Definition</th><th>Autonomy</th><th>Owner / schedule</th><th>Risk</th><th>Readiness</th><th>Last / next run</th><th>State</th></tr></thead><tbody>{loops.map((loop) => <tr key={loop.id}><td><div className="primary-cell"><strong>{loop.name}</strong><span>{loop.description}</span><code>{loop.policyVersion}</code></div></td><td><Badge value={loop.automationLevel} /></td><td><div className="stack-cell"><strong>{loop.owner}</strong><span>{loop.schedule ?? "Manual trigger"}</span></div></td><td><Badge value={loop.risk} /></td><td><div className="readiness-cell"><strong>{loop.readinessScore}</strong><Progress value={loop.readinessScore} /></div></td><td><div className="stack-cell"><span>{shortDate(loop.lastRunAt)}</span><span>Next {relativeTime(loop.nextRunAt)}</span></div></td><td><Badge value={loop.enabled ? "enabled" : "disabled"} tone={loop.enabled ? "good" : "neutral"} /></td></tr>)}</tbody></table></TableWrap>}
    </Panel>
    <Callout tone="info" title="Autonomy is earned">Readiness measures deterministic verification, breaker coverage, bounded permissions, and recovery evidence. It does not measure prompt quality.</Callout>
  </>}</QueryState>;
}

export function RunsPage() {
  const query = useApiQuery<RunRecord[]>("/runs", { refetchInterval: 5000 });
  const loopsQuery = useApiQuery<LoopDefinition[]>("/loops");
  const [queryText, setQueryText] = useState("");
  const [status, setStatus] = useState("all");
  return <QueryState query={query}>{(runs, envelope) => {
    const filtered = runs.filter((run) => (status === "all" || run.status === status) && `${run.goal} ${run.loopName} ${run.id}`.toLowerCase().includes(queryText.toLowerCase()));
    return <><PageHeader eyebrow="Execution history" title="Runs" description="Every retry preserves its evidence; terminal records remain immutable." actions={<NewRunButton loops={loopsQuery.data?.data ?? []} disabled={envelope.source === "demo"} />} /><DemoNotice source={envelope} />
      <div className="toolbar"><label className="search"><Search size={16} /><span className="sr-only">Search runs</span><input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search objective, loop, or run ID" /></label><label className="select-control"><ListFilter size={16} /><span className="sr-only">Filter by status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{["queued", "running", "waiting", "paused", "blocked", "capped", "succeeded", "failed", "timed_out", "cancelled"].map((item) => <option key={item}>{item}</option>)}</select></label><span className="result-count">{filtered.length} of {runs.length} runs</span></div>
      <Panel>{!filtered.length ? <EmptyState title="No matching runs" detail="Clear the search or status filter to see more history." /> : <TableWrap label="Run history"><table><thead><tr><th>Run</th><th>Status / risk</th><th>Stage</th><th>Started</th><th>Budget</th><th>Breaker</th><th aria-label="Open" /></tr></thead><tbody>{filtered.map((run) => <tr key={run.id}><td><RunLink id={run.id}><div className="primary-cell"><strong>{run.goal}</strong><span>{run.loopName} · {run.id} · {run.sourceMode}</span></div></RunLink></td><td><div className="badge-row"><Badge value={run.status} /><Badge value={run.risk} /></div></td><td><div className="stack-cell"><strong>{runStageLabel(run)}</strong><span>{run.waitingReason ?? relativeTime(run.updatedAt)}</span></div></td><td><div className="stack-cell"><span>{shortDate(run.startedAt)}</span><span>{run.finishedAt ? `Ended ${relativeTime(run.finishedAt)}` : run.startedAt ? relativeTime(run.startedAt) : "Not started"}</span></div></td><td><div className="table-progress"><Progress value={percent(run.budget.tokensUsed, run.budget.tokenLimit)} /><span>{run.budget.tokensUsed.toLocaleString()} tokens</span></div></td><td><Badge value={run.breaker.status} /></td><td><RunLink id={run.id}><span className="sr-only">Open {run.id}</span></RunLink></td></tr>)}</tbody></table></TableWrap>}</Panel>
    </>;
  }}</QueryState>;
}

export function ApprovalsPage() {
  const query = useApiQuery<ApprovalRecord[]>("/approvals", { refetchInterval: 5000 });
  const access = useSessionAccess();
  const [selected, setSelected] = useState<ApprovalRecord | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [view, setView] = useState<"pending" | "history">("pending");
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ approval, reason, nextDecision }: { approval: ApprovalRecord; reason: string; nextDecision: "approved" | "rejected" }) => apiMutation(`/approvals/${approval.id}/decision`, { decision: nextDecision, reason, expectedVersion: approval.version }, "PATCH"),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["api", "/approvals"] }),
        client.invalidateQueries({ queryKey: ["api", "/overview"] }),
      ]);
      setSelected(null);
      setDecision(null);
    },
  });
  const openDecision = (approval: ApprovalRecord) => {
    mutation.reset();
    setDecision(null);
    setSelected(approval);
  };
  const closeDecision = () => {
    mutation.reset();
    setDecision(null);
    setSelected(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected && decision) mutation.mutate({ approval: selected, reason: String(new FormData(event.currentTarget).get("reason")), nextDecision: decision });
  };
  return <QueryState query={query}>{(approvals, envelope) => { const visible = approvals.filter((item) => view === "pending" ? item.status === "pending" : item.status !== "pending"); return <><PageHeader eyebrow="Human gates" title="Approvals" description="Decisions are scoped to one action, target, evidence digest, and expiry." /><DemoNotice source={envelope} />
    <div className="tab-strip" role="tablist" aria-label="Approval views"><button role="tab" aria-selected={view === "pending"} className={`tab ${view === "pending" ? "active" : ""}`} onClick={() => setView("pending")}>Pending <span>{approvals.filter((item) => item.status === "pending").length}</span></button><button role="tab" aria-selected={view === "history"} className={`tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>History <span>{approvals.filter((item) => item.status !== "pending").length}</span></button></div>
    {!visible.length ? <EmptyState title={view === "pending" ? "Approval queue is clear" : "No approval history"} detail="Scoped requests will appear here when a loop reaches a human gate." /> : <div className="approval-list">{visible.map((approval) => { const canDecide = envelope.source === "api" && access.ready && access.canOperate; const unavailableReason = envelope.source === "demo" ? "Connect the local API to decide" : !access.ready ? "Waiting for the local session" : !access.canOperate ? "Operator role required to decide approvals" : undefined; const timing = approval.status === "pending" ? `Expires ${relativeTime(approval.expiresAt)}` : approval.status === "expired" ? `Expired ${relativeTime(approval.expiresAt)}` : approval.status === "revoked" ? `Revoked ${relativeTime(approval.decidedAt)}` : `Decided ${relativeTime(approval.decidedAt)}`; return <article className="approval-card" key={approval.id}><div className="approval-top"><div><div className="badge-row"><Badge value={approval.status} /><Badge value={approval.risk} /></div><h2>{approval.requestedAction}</h2><code>{approval.target}</code><Link className="approval-run-link" to={`/runs/${approval.runId}`}>Run {approval.runId}</Link></div><span className="expiry">{timing}</span></div><div className="approval-evidence"><div><span>Maker summary</span><p>{approval.makerSummary}</p></div><div><span>Independent checker</span><p><Badge value={approval.checkerVerdict} /> {approval.checkerSummary}</p></div><div><span>Evidence binding</span><code>{approval.evidenceDigest}</code><Link to={`/runs/${approval.runId}`}>Review run evidence</Link></div></div><div className="approval-bottom"><span>Requested by <strong>{approval.requestedBy}</strong> {relativeTime(approval.requestedAt)}</span>{approval.status === "pending" ? <button className="button button-primary" disabled={!canDecide} title={unavailableReason ?? "Review approval"} onClick={() => openDecision(approval)}><ShieldCheck size={16} /> Review decision</button> : <span><strong>{approval.decidedBy ?? titleCase(approval.status)}</strong>{approval.decisionReason ? ` · ${approval.decisionReason}` : ""}</span>}</div></article>; })}</div>}
    <Modal open={Boolean(selected)} onClose={closeDecision} title="Record approval decision" description={selected ? `${selected.requestedAction} · ${selected.target}` : undefined}><form className="form" onSubmit={submit}>{selected && <div className="approval-decision-context"><div><span>Run</span><code>{selected.runId}</code></div><div><span>Risk</span><Badge value={selected.risk} /></div><div><span>Evidence digest</span><code>{selected.evidenceDigest}</code></div><div><span>Independent checker</span><p><Badge value={selected.checkerVerdict} /> {selected.checkerSummary}</p></div></div>}<div className="segmented" role="radiogroup" aria-label="Approval decision"><button type="button" role="radio" aria-checked={decision === "approved"} className={decision === "approved" ? "active" : ""} onClick={() => setDecision("approved")}><CheckCircle2 size={16} /> Approve</button><button type="button" role="radio" aria-checked={decision === "rejected"} className={decision === "rejected" ? "active danger" : ""} onClick={() => setDecision("rejected")}><XCircle size={16} /> Reject</button></div><label className="field field-wide"><span>Decision reason</span><textarea name="reason" rows={4} minLength={4} required placeholder="State why the evidence is sufficient or what must change..." /></label>{mutation.error && <div className="form-error" role="alert">{mutation.error.message}</div>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeDecision}>Cancel</button><button className={decision === "rejected" ? "button button-danger" : "button button-primary"} disabled={!decision || mutation.isPending}>{mutation.isPending ? "Recording…" : decision === "approved" ? "Approve action" : decision === "rejected" ? "Reject action" : "Choose a decision"}</button></div></form></Modal>
  </>; }}</QueryState>;
}

export function AgentsPage() {
  const query = useApiQuery<AgentRecord[]>("/agents", { refetchInterval: 5000 });
  const worktreeQuery = useApiQuery<WorktreeRecord[]>("/worktrees", { refetchInterval: 5000 });
  return <QueryState query={query}>{(agents, envelope) => <><PageHeader eyebrow="Runtime" title="Agents & worktrees" description="Sessions, current observable actions, heartbeats, and isolated filesystem state." /><DemoNotice source={envelope} />
    <div className="metric-grid metric-grid-4"><Metric label="Online" value={agents.filter((agent) => ["running", "waiting", "starting"].includes(agent.status)).length} detail="Fresh heartbeat" icon={<Radio />} tone="good" /><Metric label="Working" value={agents.filter((agent) => agent.status === "running").length} detail="Active tool activity" icon={<Cpu />} tone="info" /><Metric label="Stale" value={agents.filter((agent) => agent.status === "stale").length} detail="Needs cleanup" icon={<AlertTriangle />} tone="bad" /><Metric label="Worktrees" value={agents.filter((agent) => agent.worktreePath).length} detail="Isolated checkouts" icon={<GitBranch />} /></div>
    <Panel title="Agent registry" description="Heartbeat age is authoritative; prose status is only agent-reported.">{!agents.length ? <EmptyState title="No registered agents" /> : <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}><div className="agent-head"><div className={`agent-avatar agent-${agent.role}`}><Bot size={18} /></div><div><h2>{agent.name}</h2><span>{agent.runtime} · {agent.model}</span></div><Badge value={agent.status} /></div><dl className="detail-list"><div><dt>Role</dt><dd>{titleCase(agent.role)}</dd></div><div><dt>Heartbeat</dt><dd>{relativeTime(agent.lastHeartbeatAt)}</dd></div><div><dt>Session</dt><dd><code>{agent.sessionId ?? "No active session"}</code></dd></div><div><dt>Run</dt><dd>{agent.currentRunId ? <Link to={`/runs/${agent.currentRunId}`}>{agent.currentRunId}</Link> : "Idle"}</dd></div></dl>{agent.currentAction && <div className="current-action"><span className="pulse-dot" /><div><span>Observable action</span><strong>{agent.currentAction}</strong></div></div>}{agent.worktreePath && <div className="worktree-path"><GitBranch size={15} /><code>{agent.worktreePath}</code></div>}</article>)}</div>}</Panel>
    <Panel title="Isolated worktrees" description="Attempt ownership, dirty state, commit binding, and cleanup eligibility."><QueryState query={worktreeQuery}>{(worktrees) => !worktrees.length ? <EmptyState title="No managed worktrees" detail="A maker attempt can request an isolated checkout when execution begins." /> : <TableWrap label="Managed worktrees"><table><thead><tr><th>Path</th><th>Run / attempt</th><th>Branch</th><th>Commit</th><th>Changes</th><th>State</th><th>Updated</th></tr></thead><tbody>{worktrees.map((worktree) => <tr key={worktree.id}><td><code>{worktree.path}</code></td><td><div className="stack-cell"><Link to={`/runs/${worktree.runId}`}>{worktree.runId}</Link><span>{worktree.attemptId ?? "Run level"}</span></div></td><td><code>{worktree.branch}</code></td><td><code>{worktree.commit ?? "Uncommitted"}</code></td><td><Badge value={worktree.dirty ? "dirty" : "clean"} tone={worktree.dirty ? "warn" : "good"} /></td><td><Badge value={worktree.status} /></td><td>{relativeTime(worktree.updatedAt)}</td></tr>)}</tbody></table></TableWrap>}</QueryState></Panel>
    {worktreeQuery.data?.data.some((worktree) => worktree.status === "stale" || worktree.dirty) && <Callout tone="warn" title="A worktree requires review">Cleanup is never automatic while uncommitted changes or unbound artifacts exist.</Callout>}
  </>}</QueryState>;
}

export function ArtifactsPage() {
  const query = useApiQuery<ArtifactRecord[]>("/artifacts");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [integrity, setIntegrity] = useState("all");
  const copyDigest = async (digest: string) => navigator.clipboard?.writeText(digest);
  return <QueryState query={query}>{(artifacts, envelope) => { const filtered = artifacts.filter((item) => `${item.name} ${item.digest} ${item.producer}`.toLowerCase().includes(search.toLowerCase()) && (kind === "all" || item.kind === kind) && (integrity === "all" || item.verificationStatus === integrity)); return <><PageHeader eyebrow="Evidence store" title="Artifacts" description="Immutable outputs with provenance, verification state, sensitivity, and digest binding." /><DemoNotice source={envelope} /><div className="toolbar"><label className="search"><Search size={16} /><span className="sr-only">Search artifacts</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, digest, or producer" /></label><label className="select-control"><ListFilter size={16} /><span className="sr-only">Filter artifact kind</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All kinds</option>{["diff", "report", "log", "dataset", "workbook", "other"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="select-control"><ShieldCheck size={16} /><span className="sr-only">Filter artifact integrity</span><select value={integrity} onChange={(event) => setIntegrity(event.target.value)}><option value="all">All integrity</option>{["verified", "unverified", "invalid", "missing"].map((item) => <option key={item}>{item}</option>)}</select></label><span className="result-count">{filtered.length} of {artifacts.length}</span></div><Panel>{!filtered.length ? <EmptyState title="No matching artifacts" /> : <TableWrap label="Artifacts"><table><thead><tr><th>Artifact</th><th>Kind</th><th>Run / attempt</th><th>Producer</th><th>Integrity</th><th>Access</th><th>Created</th><th aria-label="Copy digest" /></tr></thead><tbody>{filtered.map((artifact) => <tr key={artifact.id}><td><div className="file-cell"><div className="file-icon"><FileDiff size={17} /></div><div><strong>{artifact.name}</strong><span>{bytes(artifact.sizeBytes)}</span><code>{compactId(artifact.digest)}</code></div></div></td><td><Badge value={artifact.kind} /></td><td><div className="stack-cell"><Link to={`/runs/${artifact.runId}`}>{artifact.runId}</Link><span>{artifact.attemptId ?? "Run level"}</span></div></td><td>{artifact.producer}</td><td><Badge value={artifact.verificationStatus} /></td><td><Badge value={artifact.sensitivity} /></td><td>{relativeTime(artifact.createdAt)}</td><td><button className="icon-button" title="Copy artifact digest" aria-label={`Copy digest for ${artifact.name}`} onClick={() => void copyDigest(artifact.digest)}><Clipboard size={17} /></button></td></tr>)}</tbody></table></TableWrap>}</Panel></>; }}</QueryState>;
}

export function PoliciesPage() {
  const runsQuery = useApiQuery<RunRecord[]>("/runs");
  const loopsQuery = useApiQuery<LoopDefinition[]>("/loops");
  return <QueryState query={runsQuery}>{(runs, envelope) => <><PageHeader eyebrow="Guardrails" title="Policies & budgets" description="Versioned constraints turn Loop Engineering discipline into enforceable runtime behavior." /><DemoNotice source={envelope} />
    <div className="policy-grid"><Panel title="Server-enforced invariants" description="Compiled into the current Admin control plane"><div className="policy-version"><div><ShieldCheck size={22} /><span><strong>Runtime safety baseline</strong><small>Each mutation is validated and appended to the local audit ledger</small></span></div><Badge value="enforced" tone="good" /></div><dl className="rule-list"><div><dt><Users size={16} /> Maker / checker separation</dt><dd>Registered agent and session identities must differ</dd></div><div><dt><FileDiff size={16} /> Artifact binding</dt><dd>Checker evidence and approval must match the current digest</dd></div><div><dt><KeyRound size={16} /> Human approval</dt><dd>Required when the run includes a non-skipped human stage</dd></div><div><dt><TimerReset size={16} /> Default breaker ceilings</dt><dd>3 same errors or 5 consecutive failures</dd></div><div><dt><LockKeyhole size={16} /> Snapshot isolation</dt><dd>Imported snapshots are read-only and never presented as live state</dd></div></dl></Panel>
      <Panel title="Rejected mutations" description="Requests the server refuses to persist"><div className="deny-list"><div><XCircle size={17} /><div><strong>Illegal or stale state changes</strong><span>Terminal rewrites and failed compare-and-swap updates</span></div></div><div><XCircle size={17} /><div><strong>Unbound completion claims</strong><span>Missing requirements, evidence, checker verdict, or approval digest</span></div></div><div><XCircle size={17} /><div><strong>Secret material in telemetry</strong><span>Recognized credentials are redacted before persistence and display</span></div></div><div><XCircle size={17} /><div><strong>Self-verification</strong><span>Maker agent or session cannot submit its own checker verdict</span></div></div></div></Panel></div>
    <Callout tone="info" title="Runner permissions remain explicit">Filesystem, network, deployment, and secret scopes belong to the connected agent runner. The Admin records those observable actions but does not claim to sandbox a runner process.</Callout>
    <Panel title="Active run budgets" description="The breaker opens at a hard limit; warnings do not extend the budget.">{!runs.length ? <EmptyState title="No run budgets" /> : <TableWrap label="Active budgets"><table><thead><tr><th>Run</th><th>Tokens</th><th>Cost</th><th>Iterations</th><th>Warning</th><th>Breaker</th></tr></thead><tbody>{runs.filter((run) => !run.finishedAt).map((run) => <tr key={run.id}><td><RunLink id={run.id}><div className="primary-cell"><strong>{run.goal}</strong><span>{run.id}</span></div></RunLink></td><td><BudgetCell used={run.budget.tokensUsed} limit={run.budget.tokenLimit} format={(value) => value.toLocaleString()} /></td><td><BudgetCell used={run.budget.costUsedUsd} limit={run.budget.costLimitUsd} format={(value) => `$${value.toFixed(2)}`} /></td><td><BudgetCell used={run.budget.iterationsUsed} limit={run.budget.iterationLimit} format={String} /></td><td>{run.budget.warningPercent}%</td><td><Badge value={run.breaker.status} /></td></tr>)}</tbody></table></TableWrap>}</Panel>
    <Panel title="Policy assignments" description="Loop definitions pin a version so historical behavior remains explainable"><div className="version-list">{loopsQuery.data?.data.map((loop) => <div key={loop.id}><div><strong>{loop.name}</strong><span>{loop.owner}</span></div><code>{loop.policyVersion}</code><Badge value={loop.risk} /></div>)}</div></Panel>
  </>}</QueryState>;
}

function BudgetCell({ used, limit, format }: { used: number; limit: number; format: (value: number) => string }) { const value = percent(used, limit); return <div className="budget-cell"><div><strong>{format(used)}</strong><span>/ {format(limit)}</span></div><Progress value={value} /></div>; }

export function AuditPage() {
  const query = useApiQuery<AuditRecord[]>("/audit");
  const [search, setSearch] = useState("");
  const exportAudit = (records: AuditRecord[]) => { const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = `loop-audit-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(anchor.href); };
  return <QueryState query={query}>{(records, envelope) => { const filtered = records.filter((record) => `${record.actor} ${record.action} ${record.targetId} ${record.reason}`.toLowerCase().includes(search.toLowerCase())); return <><PageHeader eyebrow="Immutable ledger" title="Audit" description="Append-only operator and runtime decisions with reasons and target identity." actions={<button className="button button-secondary" onClick={() => exportAudit(filtered)}><ArrowDownToLine size={16} /> Export JSON</button>} /><DemoNotice source={envelope} /><div className="toolbar"><label className="search"><Search size={16} /><span className="sr-only">Search audit log</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actor, action, target, or reason" /></label><span className="result-count">{filtered.length} records</span></div><Panel>{!filtered.length ? <EmptyState title="No matching audit records" /> : <TableWrap label="Audit records"><table className="audit-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th><th>Run</th><th>Metadata</th></tr></thead><tbody>{filtered.map((record) => <tr key={record.id}><td><div className="stack-cell"><strong>{shortDate(record.createdAt)}</strong><span>{relativeTime(record.createdAt)}</span></div></td><td><div className="stack-cell"><strong>{record.actor}</strong><Badge value={record.actorRole} /></div></td><td><code>{record.action}</code></td><td><div className="stack-cell"><strong>{record.targetType}</strong><code>{compactId(record.targetId)}</code></div></td><td>{record.reason ?? "—"}</td><td>{record.runId ? <Link to={`/runs/${record.runId}`}>{record.runId}</Link> : "Workspace"}</td><td><code>{Object.keys(record.metadata).length ? JSON.stringify(record.metadata) : "{}"}</code></td></tr>)}</tbody></table></TableWrap>}</Panel></>; }}</QueryState>;
}
