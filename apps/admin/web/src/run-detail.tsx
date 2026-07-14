import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertOctagon, ArrowLeft, Ban, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, CirclePause, CirclePlay, Clipboard, Clock3, Code2, FileCheck2, FileClock, FileDiff, GitBranch, Hourglass, ListChecks, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, Square, Terminal, UserCheck, XCircle, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useGlobalPauseState, useSessionAccess } from "./access";
import { apiMutation, useApiQuery } from "./api";
import { Badge, Callout, DemoNotice, EmptyState, Modal, PageHeader, Panel, Progress, QueryState, TableWrap, cx } from "./components";
import type { AttemptRecord, RunDetailResponse, RunRecord, StageRecord } from "./types";
import { bytes, compactId, duration, percent, relativeTime, shortDate, titleCase } from "./utils";

type RunAction = "start" | "pause" | "resume" | "cancel" | "retry" | "override_breaker";

const actionConfig: Record<RunAction, { label: string; icon: typeof Play; danger?: boolean; reason: string }> = {
  start: { label: "Mark running", icon: Play, reason: "Why should this queued record begin tracking active work?" },
  pause: { label: "Pause", icon: Pause, reason: "Why is the run being paused?" },
  resume: { label: "Resume", icon: CirclePlay, reason: "What changed so this run can continue?" },
  cancel: { label: "Cancel", icon: Ban, danger: true, reason: "Why must this run be cancelled?" },
  retry: { label: "Retry", icon: RotateCcw, reason: "What evidence supports another bounded attempt?" },
  override_breaker: { label: "Override breaker", icon: Zap, danger: true, reason: "Document the risk acceptance and changed condition." },
};

const actionsFor = (run: RunRecord): RunAction[] => {
  if (run.status === "queued") return ["start", "cancel"];
  if (run.status === "running") return ["pause", "cancel"];
  if (run.status === "waiting" || run.status === "paused") return ["resume", "cancel"];
  if (run.status === "blocked") return run.breaker.status === "open" ? ["override_breaker", "cancel"] : ["resume", "cancel"];
  if (["failed", "timed_out", "cancelled", "capped"].includes(run.status)) return ["retry"];
  return [];
};

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const query = useApiQuery<RunDetailResponse>(`/runs/${runId}`, { refetchInterval: 3000 });
  const stream = useRunEventStream(runId, query.data?.source === "api", query.data?.data.run.lastSequence ?? 0);
  return <QueryState query={query}>{(detail, envelope) => <RunWorkspace detail={detail} demo={envelope.source === "demo"} envelope={envelope} stream={stream} />}</QueryState>;
}

function useRunEventStream(runId: string, enabled: boolean, afterSequence: number) {
  const client = useQueryClient();
  const [state, setState] = useState<"connecting" | "live" | "reconnecting" | "polling">("polling");
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") { setState("polling"); return; }
    setState("connecting");
    let invalidateTimer: number | undefined;
    const invalidate = () => {
      if (invalidateTimer !== undefined) return;
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = undefined;
        void client.invalidateQueries({ queryKey: ["api", `/runs/${runId}`] });
      }, 200);
    };
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events/stream?after=${afterSequence}`);
    source.onopen = () => setState("live");
    source.addEventListener("loop-event", () => { setState("live"); invalidate(); });
    source.addEventListener("stream-gap", () => { setState("reconnecting"); invalidate(); });
    source.onerror = () => setState("reconnecting");
    return () => {
      source.close();
      if (invalidateTimer !== undefined) window.clearTimeout(invalidateTimer);
    };
    // afterSequence is the initial cursor. Browser reconnects continue with Last-Event-ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, runId]);
  return state;
}

function RunWorkspace({ detail, demo, envelope, stream }: { detail: RunDetailResponse; demo: boolean; envelope: Parameters<typeof DemoNotice>[0]["source"]; stream: "connecting" | "live" | "reconnecting" | "polling" }) {
  const { run } = detail;
  const [tab, setTab] = useState<"activity" | "attempts" | "evidence">("activity");
  const [action, setAction] = useState<RunAction | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const access = useSessionAccess();
  const globalPause = useGlobalPauseState();
  const mutation = useMutation({
    mutationFn: ({ action: nextAction, reason }: { action: RunAction; reason: string }) => apiMutation<RunRecord>(`/runs/${run.id}/actions`, { action: nextAction, reason, expectedStatus: run.status }),
    onSuccess: async (updatedRun, variables) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["api", `/runs/${run.id}`] }),
        client.invalidateQueries({ queryKey: ["api", "/runs"] }),
        client.invalidateQueries({ queryKey: ["api", "/overview"] }),
      ]);
      setAction(null);
      if (variables.action === "retry" && updatedRun.id !== run.id) navigate(`/runs/${updatedRun.id}`);
    },
  });
  const submitAction = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (action) mutation.mutate({ action, reason: String(new FormData(event.currentTarget).get("reason")) }); };
  const currentAgent = detail.agents.find((agent) => agent.status === "running");
  const activeAttempt = [...detail.attempts].reverse().find((attempt) => attempt.status === "running");
  const latestEvent = detail.events.reduce((latest, event) => !latest || event.sequence > latest.sequence ? event : latest, detail.events[0]);
  const availableActions = actionsFor(run);
  const currentRequirements = detail.requirements.filter((requirement) => !requirement.supersededAt);
  const previousRequirements = detail.requirements.filter((requirement) => Boolean(requirement.supersededAt));
  const unavailableReason = (item: RunAction): string | undefined => {
    if (demo) return "Connect the local API to control this run";
    if (run.sourceMode === "snapshot") return "Imported snapshot runs are read-only";
    if (!access.ready) return "Waiting for the local session";
    if (item === "override_breaker" && !access.canAdminister) return "Admin role required to override a breaker";
    if (!access.canOperate) return "Operator role required to control a run";
    if ((item === "start" || item === "resume") && !globalPause.ready) return "Waiting for workspace dispatch state";
    if ((item === "start" || item === "resume") && globalPause.paused) return "Resume workspace dispatch before continuing this run";
    return undefined;
  };

  return <>
    <div className="breadcrumb"><Link to="/runs"><ArrowLeft size={15} /> Runs</Link><ChevronRight size={14} /><span>{run.id}</span></div>
    <PageHeader eyebrow={`${run.projectName} · ${run.loopName} · ${run.automationLevel}`} title={run.goal} description={`${run.id} · ${run.repositoryPath ?? "No repository"} · ${run.runtime} / ${run.model}`} actions={<div className="run-actions"><Badge value={run.status} />{availableActions.map((item) => { const config = actionConfig[item]; const Icon = config.icon; const reason = unavailableReason(item); return <button key={item} disabled={Boolean(reason)} title={reason ?? config.label} className={config.danger ? "button button-danger-quiet" : item === "resume" || item === "start" ? "button button-primary" : "button button-secondary"} onClick={() => { mutation.reset(); setAction(item); }}><Icon size={16} /> {config.label}</button>; })}</div>} />
    <DemoNotice source={envelope} />
    {run.sourceMode === "snapshot" && <Callout tone="warn" title="Read-only snapshot">This run was imported from local state files. It is not live telemetry and control actions are unavailable.</Callout>}
    {run.status === "blocked" && <Callout tone="bad" title={`Blocked: ${run.blockedOwner ?? "Owner required"}`}>{run.unblockCondition ?? "No explicit unblock condition was recorded."}</Callout>}
    {run.waitingReason && run.status === "waiting" && <Callout tone="warn" title="Waiting for progress">{run.waitingReason}</Callout>}
    {run.sourceMode === "managed" && ["queued", "running", "waiting", "paused"].includes(run.status) && !currentAgent && <RunnerAttachPanel run={run} />}
    <section className="run-objective" aria-labelledby="objective-heading"><div><span className="section-kicker">Execution contract</span><h2 id="objective-heading">Objective & acceptance requirements</h2><p>{run.goal}</p><div className="objective-meta"><span>{run.startedAt ? `Started ${relativeTime(run.startedAt)}` : "Not started"}</span><span>Updated {relativeTime(run.updatedAt)}</span><span>Revision {Math.max(0, ...detail.requirements.map((item) => item.revision))}</span></div></div><div className="requirement-list">{currentRequirements.length ? currentRequirements.map((requirement) => <div key={requirement.id} className={`requirement-${requirement.status}`}>{requirement.status === "pass" ? <CheckCircle2 size={16} /> : requirement.status === "fail" ? <XCircle size={16} /> : requirement.status === "missing" ? <AlertOctagon size={16} /> : <Clock3 size={16} />}<span><strong>{requirement.title}</strong><small>{requirement.acceptanceCriteria}</small></span><Badge value={requirement.status} tone={requirement.status === "pass" ? "good" : requirement.status === "fail" ? "bad" : "warn"} /></div>) : <div className="requirement-missing"><AlertOctagon size={16} /><span><strong>No signed requirements</strong><small>Completion is blocked until acceptance criteria are recorded.</small></span></div>}</div>{previousRequirements.length > 0 && <details className="revision-history"><summary>{previousRequirements.length} superseded requirement {previousRequirements.length === 1 ? "revision" : "revisions"}</summary><div>{previousRequirements.map((requirement) => <div key={requirement.id}><span>Revision {requirement.revision}</span><strong>{requirement.title}</strong><small>Superseded {relativeTime(requirement.supersededAt)}</small></div>)}</div></details>}</section>
    <StageRail stages={detail.stages} />
    <div className="run-layout">
      <div className="run-main">
        <Panel className="current-work" title="Current observable work" description="Latest action reported by runtime telemetry, not private reasoning." actions={<span className={cx("live-indicator", stream !== "live" && "live-delayed")}><span /> {demo ? "Demo" : stream === "polling" ? "Polling" : titleCase(stream)}</span>}>
          {currentAgent ? <div className="current-work-body"><div className="action-symbol"><Code2 size={22} /></div><div className="action-detail"><span>{currentAgent.name} · {currentAgent.runtime} · {currentAgent.model}</span><strong>{currentAgent.currentAction ?? "Waiting for the next observable action"}</strong><div><code>{currentAgent.worktreePath ?? "No worktree"}</code><span>Heartbeat {relativeTime(currentAgent.lastHeartbeatAt)}</span></div></div></div> : <EmptyState title="No active agent" detail="The controller has not assigned an agent to this stage." />}
          {latestEvent && <div className="latest-command"><Terminal size={15} /><span>{latestEvent.message}</span><time>{relativeTime(latestEvent.occurredAt)}</time></div>}
        </Panel>
        <div className="detail-tabs" role="tablist" aria-label="Run detail sections">
          <button role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}><Activity size={16} /> Activity & logs <span>{detail.events.length}</span></button>
          <button role="tab" aria-selected={tab === "attempts"} className={tab === "attempts" ? "active" : ""} onClick={() => setTab("attempts")}><RefreshCw size={16} /> Attempts <span>{detail.attempts.length}</span></button>
          <button role="tab" aria-selected={tab === "evidence"} className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}><FileCheck2 size={16} /> Verification & evidence <span>{detail.verifications.length + detail.artifacts.length}</span></button>
        </div>
        {tab === "activity" && <ActivityTab detail={detail} />}
        {tab === "attempts" && <AttemptsTab detail={detail} />}
        {tab === "evidence" && <EvidenceTab detail={detail} />}
      </div>
      <aside className="run-aside" aria-label="Run controls and guardrails">
        <Panel title="Run state"><dl className="detail-list"><div><dt>Status</dt><dd><Badge value={run.status} /></dd></div><div><dt>Current stage</dt><dd>{run.currentStageName ?? (run.status === "queued" ? "Not started" : "Awaiting telemetry")}</dd></div><div><dt>Requirements</dt><dd>{run.requirementProgress.passed}/{run.requirementProgress.total} passed</dd></div><div><dt>Risk</dt><dd><Badge value={run.risk} /></dd></div><div><dt>Runtime</dt><dd>{run.runtime}</dd></div><div><dt>Model</dt><dd>{run.model}</dd></div><div><dt>Source</dt><dd><Badge value={run.sourceMode} /></dd></div><div><dt>Event sequence</dt><dd>#{run.lastSequence}</dd></div><div><dt>Last telemetry</dt><dd>{relativeTime(run.lastEventAt)}</dd></div></dl></Panel>
        <BudgetInspector run={run} />
        <BreakerInspector run={run} />
        <ApprovalInspector detail={detail} />
        {activeAttempt && <Panel title="Active binding"><dl className="detail-list"><div><dt>Attempt</dt><dd>#{activeAttempt.number}</dd></div><div><dt>Maker session</dt><dd><code>{compactId(activeAttempt.makerSessionId)}</code></dd></div><div><dt>Checker session</dt><dd><code>{activeAttempt.checkerSessionId ? compactId(activeAttempt.checkerSessionId) : "Not assigned"}</code></dd></div><div><dt>Artifact digest</dt><dd><code>{activeAttempt.artifactDigest ? compactId(activeAttempt.artifactDigest) : "Pending"}</code></dd></div></dl></Panel>}
      </aside>
    </div>
    <Modal open={Boolean(action)} onClose={() => setAction(null)} title={action ? `${actionConfig[action].label} run` : "Run action"} description={`Current status: ${run.status} · Action is appended to the audit ledger.`}><form className="form" onSubmit={submitAction}>{action === "start" && <Callout tone="info" title="Tracking state only">Mark running updates the control-plane state. It does not launch Codex, Claude, or another process; use the runner command on this page to launch and stream real work.</Callout>}<label className="field field-wide"><span>Required reason</span><textarea name="reason" required minLength={4} rows={4} autoFocus placeholder={action ? actionConfig[action].reason : "Document the reason..."} /></label>{action === "override_breaker" && <Callout tone="bad" title="Breaker overrides are exceptional">This does not erase the trigger. The override identity and reason remain in the immutable audit record.</Callout>}{mutation.error && <div className="form-error" role="alert">{mutation.error.message}</div>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setAction(null)}>Back</button><button className={action && actionConfig[action].danger ? "button button-danger" : "button button-primary"} disabled={mutation.isPending}>{mutation.isPending ? "Applying…" : `Confirm ${action ? actionConfig[action].label.toLowerCase() : "action"}`}</button></div></form></Modal>
  </>;
}

function RunnerAttachPanel({ run }: { run: RunRecord }) {
  const [copied, setCopied] = useState(false);
  const runtime = run.runtime.toLowerCase();
  const command = runtime.includes("claude") ? `claude -p ${shellQuote(run.goal)}`
    : runtime.includes("gemini") ? `gemini -p ${shellQuote(run.goal)}`
    : runtime.includes("openhands") ? `openhands ${shellQuote(run.goal)}`
    : runtime.includes("codex") ? `codex exec ${shellQuote(run.goal)}`
    : "npm test";
  const cwd = run.repositoryPath ? ` --cwd ${shellQuote(run.repositoryPath)}` : "";
  const stage = run.currentStageId ? ` --stage ${shellQuote(run.currentStageId)}` : "";
  const invocation = `npm run admin:run -- --run ${shellQuote(run.id)}${stage}${cwd} -- ${command}`;
  const copy = async () => {
    await navigator.clipboard?.writeText(invocation);
    setCopied(true);
  };

  return <section className="runner-attach" aria-labelledby="runner-attach-heading">
    <div className="runner-attach-icon"><Terminal size={20} aria-hidden="true" /></div>
    <div className="runner-attach-body"><span className="section-kicker">Local runner</span><h2 id="runner-attach-heading">Attach real execution telemetry</h2><p>Run this from the cloned Admin repository. The wrapper launches the command locally and streams observable stdout, stderr, exit status, and duration into this run. Replace everything after <code>--</code> with Codex, Claude, or any command.</p><div className="runner-command"><code>{invocation}</code><button type="button" className="icon-button" title="Copy runner command" aria-label="Copy runner command" onClick={() => void copy()}><Clipboard size={16} /></button></div><span className="copy-status" role="status" aria-live="polite">{copied ? "Runner command copied" : "The Admin records telemetry; it does not launch a process by changing run status."}</span></div>
  </section>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function StageRail({ stages }: { stages: StageRecord[] }) {
  return <section className="stage-section" aria-labelledby="stage-heading"><div className="section-row"><div><span className="section-kicker">Workflow</span><h2 id="stage-heading">Stage progression</h2></div><span>{stages.filter((stage) => stage.status === "passed").length} of {stages.length} passed</span></div>
    {!stages.length ? <EmptyState title="No stages reported" /> : <div className="stage-rail" role="list">{stages.map((stage, index) => { const detail = stage.waitingReason ?? stage.skipReason ?? (stage.status === "active" ? `Running ${relativeTime(stage.startedAt)}` : stage.status === "passed" ? duration(stage.durationMs) : titleCase(stage.status)); return <div className={cx("stage", `stage-${stage.status}`)} key={stage.id} role="listitem"><div className="stage-track"><span className="stage-node">{stage.status === "passed" ? <Check size={14} /> : stage.status === "active" ? <CircleDot size={14} /> : stage.status === "failed" || stage.status === "rejected" || stage.status === "blocked" ? <XCircle size={14} /> : index + 1}</span></div><div><span>{titleCase(stage.role)}</span><strong>{stage.name}</strong><small title={detail}>{detail}</small></div></div>; })}</div>}
  </section>;
}

function ActivityTab({ detail }: { detail: RunDetailResponse }) {
  const orderedEvents = [...detail.events].sort((a, b) => b.sequence - a.sequence);
  const [expanded, setExpanded] = useState<string | null>(orderedEvents[0]?.id ?? null);
  return <Panel title="Observable activity" description="Runtime facts, agent reports, derived state, and human actions disclose their provenance.">{!orderedEvents.length ? <EmptyState title="No activity events" /> : <div className="timeline">{orderedEvents.map((event) => <div className={`timeline-row timeline-${event.severity}`} key={event.id}><div className="timeline-time"><time>{shortDate(event.occurredAt)}</time><span>#{event.sequence}</span></div><div className="timeline-marker"><span /></div><div className="timeline-content"><button className="timeline-summary" aria-expanded={expanded === event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)}><span><strong>{event.message}</strong><small>{event.actor} · {titleCase(event.provenance)} · {event.type}</small></span><ChevronDown size={16} /></button>{expanded === event.id && <div className="event-payload"><div><span>Stage</span><code>{event.stageId ?? "run-level"}</code></div><div><span>Attempt</span><code>{event.attemptId ?? "none"}</code></div><div><span>Correlation</span><code>{event.correlationId ?? "none"}</code></div>{Object.keys(event.payload).length > 0 && <pre>{JSON.stringify(event.payload, null, 2)}</pre>}{event.redacted && <Badge value="redacted" tone="warn" />}</div>}</div></div>)}</div>}</Panel>;
}

function AttemptsTab({ detail }: { detail: RunDetailResponse }) {
  return <Panel title="Immutable attempts" description="A retry creates a new record. Previous failures and checker feedback remain visible.">{!detail.attempts.length ? <EmptyState title="No attempts yet" /> : <div className="attempt-list">{[...detail.attempts].reverse().map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} detail={detail} />)}</div>}</Panel>;
}

function AttemptRow({ attempt, detail }: { attempt: AttemptRecord; detail: RunDetailResponse }) {
  const checks = detail.verifications.filter((item) => item.attemptId === attempt.id);
  const previousAttempt = attempt.previousAttemptId ? detail.attempts.find((item) => item.id === attempt.previousAttemptId) : undefined;
  return <article className="attempt-row"><div className="attempt-header"><div className="attempt-number">{attempt.number}</div><div><div className="badge-row"><Badge value={attempt.status} /><Badge value={attempt.checkerStatus} /></div><h3>Attempt {attempt.number}</h3><span>{shortDate(attempt.startedAt)} · {attempt.finishedAt ? `finished ${relativeTime(attempt.finishedAt)}` : "in progress"}</span></div><div className="attempt-branch"><GitBranch size={15} /><code>{attempt.branch ?? "No branch"}</code></div></div>{attempt.previousAttemptId && <div className="retry-lineage"><RotateCcw size={16} /><div><strong>{previousAttempt ? `Retry of attempt ${previousAttempt.number}` : `Retry of ${compactId(attempt.previousAttemptId)}`}</strong>{attempt.feedbackSummary && <p>{attempt.feedbackSummary}</p>}{attempt.feedbackReviewId && <code>Review {compactId(attempt.feedbackReviewId)}</code>}</div></div>}<div className="separation-grid"><div><span>Maker</span><strong>{attempt.makerAgentId}</strong><code>{compactId(attempt.makerSessionId)}</code></div><div className="separation-arrow"><ChevronRight size={18} /></div><div><span>Independent checker</span><strong>{attempt.checkerAgentId ?? "Not assigned"}</strong><code>{attempt.checkerSessionId ? compactId(attempt.checkerSessionId) : "Pending artifact"}</code></div><div><span>Artifact binding</span><strong>{attempt.artifactDigest ? "Digest captured" : "Awaiting artifact"}</strong><code>{attempt.artifactDigest ?? "—"}</code></div></div>{attempt.checkerSummary && <div className={attempt.checkerStatus === "reject" ? "checker-note checker-reject" : "checker-note"}><UserCheck size={17} /><div><strong>Checker verdict</strong><p>{attempt.checkerSummary}</p></div></div>}<div className="check-summary">{checks.map((check) => <div key={check.id}>{check.status === "passed" ? <CheckCircle2 size={15} /> : check.status === "failed" ? <XCircle size={15} /> : <Hourglass size={15} />}<span>{check.name}</span><Badge value={check.status} /></div>)}</div></article>;
}

function EvidenceTab({ detail }: { detail: RunDetailResponse }) {
  const currentRequirements = detail.requirements.filter((requirement) => !requirement.supersededAt);
  return <><Panel title="Requirement traceability" description="Every completion claim must resolve to current, reproducible evidence.">{!currentRequirements.length ? <EmptyState title="No signed requirements" /> : <div className="traceability-list">{currentRequirements.map((requirement) => { const boundEvidence = detail.evidence.filter((item) => item.requirementId === requirement.id); return <div key={requirement.id}><div className="trace-status"><Badge value={requirement.status} tone={requirement.status === "pass" ? "good" : requirement.status === "fail" ? "bad" : "warn"} /><code>{compactId(requirement.contentHash)}</code></div><div><strong>{requirement.title}</strong><p>{requirement.acceptanceCriteria}</p>{requirement.checkerSummary && <span>Checker: {requirement.checkerSummary}</span>}</div><div className="bound-evidence">{boundEvidence.length ? boundEvidence.map((item) => <div key={item.id}><Badge value={item.status} tone={item.status === "pass" ? "good" : item.status === "running" ? "info" : item.status === "missing" ? "warn" : "bad"} /><span>{item.summary}</span><small>{item.producer} · {titleCase(item.provenance)}</small></div>) : <span className="missing-evidence">No current evidence bound</span>}</div></div>; })}</div>}</Panel><Panel title="Deterministic verification" description="Commands and outputs are evidence. A model's confidence is not.">{!detail.verifications.length ? <EmptyState title="No checks reported" /> : <TableWrap label="Verification checks"><table><thead><tr><th>Check</th><th>Attempt</th><th>Status</th><th>Command</th><th>Duration</th><th>Evidence</th></tr></thead><tbody>{detail.verifications.map((check) => <tr key={check.id}><td><div className="primary-cell"><strong>{check.name}</strong><span>{check.outputPreview ?? "No output preview"}</span></div></td><td>{detail.attempts.find((attempt) => attempt.id === check.attemptId)?.number ?? "—"}</td><td><Badge value={check.status} /></td><td><code>{check.command}</code></td><td>{check.status === "skipped" ? "Skipped" : duration(check.durationMs)}</td><td><code>{check.evidenceDigest ? compactId(check.evidenceDigest) : "Pending"}</code></td></tr>)}</tbody></table></TableWrap>}</Panel><Panel title="Bound artifacts" description="Downloads remain separately authorized even when metadata is visible.">{!detail.artifacts.length ? <EmptyState title="No artifacts captured" /> : <div className="artifact-list">{detail.artifacts.map((artifact) => <div key={artifact.id}><div className="file-icon"><FileDiff size={17} /></div><div><strong>{artifact.name}</strong><span>{artifact.kind} · {bytes(artifact.sizeBytes)} · {artifact.producer}</span><code>{artifact.digest}</code></div><Badge value={artifact.verificationStatus} /><Badge value={artifact.sensitivity} /></div>)}</div>}</Panel><Panel title="Audit linkage" description="Operator and controller decisions associated with this run"><div className="mini-audit">{detail.audit.map((record) => <div key={record.id}><time>{shortDate(record.createdAt)}</time><code>{record.action}</code><span>{record.actor}{record.reason ? ` · ${record.reason}` : ""}</span></div>)}</div></Panel></>;
}

function BudgetInspector({ run }: { run: RunRecord }) {
  const budgets = [
    { label: "Tokens", used: run.budget.tokensUsed, limit: run.budget.tokenLimit, display: `${run.budget.tokensUsed.toLocaleString()} / ${run.budget.tokenLimit.toLocaleString()}` },
    { label: "Cost", used: run.budget.costUsedUsd, limit: run.budget.costLimitUsd, display: `$${run.budget.costUsedUsd.toFixed(2)} / $${run.budget.costLimitUsd.toFixed(2)}` },
    { label: "Iterations", used: run.budget.iterationsUsed, limit: run.budget.iterationLimit, display: `${run.budget.iterationsUsed} / ${run.budget.iterationLimit}` },
  ];
  return <Panel title="Budget"><div className="budget-stack">{budgets.map((item) => <div key={item.label}><div><span>{item.label}</span><strong>{item.display}</strong></div><Progress value={percent(item.used, item.limit)} warnAt={run.budget.warningPercent} /></div>)}</div><div className="inspector-foot"><Clock3 size={14} /> Warning threshold at {run.budget.warningPercent}%</div></Panel>;
}

function BreakerInspector({ run }: { run: RunRecord }) {
  const breaker = run.breaker;
  return <Panel title="Circuit breaker" actions={<Badge value={breaker.status} />}><div className="breaker-gauges"><div><strong>{breaker.sameErrorCount}<span>/{breaker.sameErrorLimit}</span></strong><span>Same error</span></div><div><strong>{breaker.consecutiveFailures}<span>/{breaker.consecutiveFailureLimit}</span></strong><span>Consecutive failures</span></div></div>{breaker.errorSignature && <div className="signature"><span>Error signature</span><code>{breaker.errorSignature}</code></div>}{breaker.trigger ? <Callout tone="bad" title="Breaker trigger">{breaker.trigger}</Callout> : <div className="inspector-foot"><ShieldCheck size={14} /> No stop condition reached</div>}</Panel>;
}

function ApprovalInspector({ detail }: { detail: RunDetailResponse }) {
  const approval = detail.approvals.find((item) => item.status === "pending") ?? detail.approvals[0];
  return <Panel title="Approval gate" actions={approval && <Badge value={approval.status} />}>{approval ? <div className="approval-inspector"><strong>{approval.requestedAction}</strong><code>{approval.target}</code><span>Evidence <code>{compactId(approval.evidenceDigest)}</code></span><Link className="button button-secondary" to="/approvals"><ShieldCheck size={15} /> Review evidence</Link></div> : <div className="empty-mini"><FileClock size={18} /><span>No approval is currently required.</span></div>}</Panel>;
}
