import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  actionRequiresReason,
  assertIndependentChecker,
  assertMatchingDigest,
  assertRunCanSucceed,
  assertRunTransition,
  assertStageTransition,
  isTerminalRun,
  redactText,
  redactValue,
  type AgentRecord,
  type ApprovalDecisionInput,
  type ApprovalRecord,
  type ArtifactRecord,
  type AttemptRecord,
  type AuditRecord,
  type CheckerVerdictInput,
  type CreateRunInput,
  type EventInput,
  type EventRecord,
  type EvidenceRecord,
  type LoopDefinition,
  type OverviewResponse,
  type RequirementRecord,
  type ReviewRecord,
  type Role,
  type RunActionInput,
  type RunDetailResponse,
  type RunRecord,
  type RunStatus,
  type RuntimeFactInput,
  type RuntimeFactReceipt,
  type StageRecord,
  type StageStatus,
  type VerificationRecord,
  type WorktreeRecord,
} from "@loop-engineering/control-plane";
import type { Actor } from "./auth.js";
import { transaction } from "./database.js";
import { conflict, HttpError, notFound } from "./errors.js";
import { EventHub } from "./event-hub.js";

type Row = Record<string, any>;

const AGENT_STALE_AFTER_MS = 5 * 60_000;

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeText(value: string): string {
  return redactText(value).value;
}

function safeNullableText(value: string | null): string | null {
  return value === null ? null : safeText(value);
}

function freshness(lastEventAt: string | null, sourceMode: "managed" | "snapshot"): RunRecord["freshness"] {
  if (!lastEventAt) return "unknown";
  const age = Date.now() - Date.parse(lastEventAt);
  if (!Number.isFinite(age)) return "unknown";
  if (sourceMode === "snapshot") return age > 15 * 60_000 ? "stale" : "delayed";
  if (age < 60_000) return "live";
  if (age < 5 * 60_000) return "delayed";
  return "stale";
}

function mapLoop(row: Row): LoopDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    automationLevel: row.automation_level,
    owner: row.owner,
    schedule: row.schedule,
    risk: row.risk,
    readinessScore: row.readiness_score,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    policyVersion: row.policy_version,
  };
}

function mapRun(row: Row): RunRecord {
  const sourceMode = row.source_mode as RunRecord["sourceMode"];
  return {
    id: row.id,
    loopId: row.loop_id,
    loopName: row.loop_name ?? "Unknown loop",
    projectName: safeText(row.project_name),
    repositoryPath: row.repository_path,
    runtime: row.runtime,
    model: row.model,
    goal: safeText(row.goal),
    status: row.status,
    automationLevel: row.automation_level,
    risk: row.risk,
    currentStageId: row.current_stage_id,
    currentStageName: row.current_stage_name ?? null,
    waitingReason: safeNullableText(row.waiting_reason),
    blockedOwner: safeNullableText(row.blocked_owner),
    unblockCondition: safeNullableText(row.unblock_condition),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    lastEventAt: row.last_event_at,
    lastSequence: row.last_sequence,
    sourceMode,
    freshness: freshness(row.last_event_at, sourceMode),
    requirementProgress: {
      total: Number(row.requirement_total ?? 0),
      passed: Number(row.requirement_passed ?? 0),
      failed: Number(row.requirement_failed ?? 0),
      missing: Number(row.requirement_missing ?? 0),
    },
    budget: {
      tokenLimit: row.token_limit,
      tokensUsed: row.tokens_used,
      costLimitUsd: row.cost_limit_usd,
      costUsedUsd: row.cost_used_usd,
      iterationLimit: row.iteration_limit,
      iterationsUsed: row.iterations_used,
      warningPercent: row.warning_percent,
    },
    breaker: {
      status: row.breaker_status,
      sameErrorCount: row.same_error_count,
      sameErrorLimit: row.same_error_limit,
      consecutiveFailures: row.consecutive_failures,
      consecutiveFailureLimit: row.consecutive_failure_limit,
      trigger: row.breaker_trigger,
      errorSignature: row.error_signature,
      openedAt: row.breaker_opened_at,
      overriddenBy: row.breaker_overridden_by,
    },
  };
}

function mapStage(row: Row): StageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    key: row.key,
    name: row.name,
    position: row.position,
    role: row.role,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    waitingReason: safeNullableText(row.waiting_reason),
    skipReason: safeNullableText(row.skip_reason),
  };
}

function mapAttempt(row: Row): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    number: row.number,
    status: row.status,
    makerAgentId: row.maker_agent_id,
    makerSessionId: row.maker_session_id,
    checkerAgentId: row.checker_agent_id,
    checkerSessionId: row.checker_session_id,
    checkerStatus: row.checker_status,
    checkerSummary: safeNullableText(row.checker_summary),
    artifactDigest: row.artifact_digest,
    worktreePath: row.worktree_path,
    branch: row.branch,
    previousAttemptId: row.previous_attempt_id ?? null,
    feedbackReviewId: row.feedback_review_id ?? null,
    feedbackSummary: safeNullableText(row.feedback_summary ?? null),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapVerification(row: Row): VerificationRecord {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    name: row.name,
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    evidenceDigest: row.evidence_digest,
    outputPreview: safeNullableText(row.output_preview),
  };
}

function mapRequirement(row: Row): RequirementRecord {
  return {
    id: row.id,
    runId: row.run_id,
    revision: row.revision,
    position: row.position,
    title: safeText(row.title),
    description: safeText(row.description),
    acceptanceCriteria: safeText(row.acceptance_criteria),
    status: row.status,
    contentHash: row.content_hash,
    evidenceIds: parseJson(row.evidence_ids_json, []),
    checkerSummary: safeNullableText(row.checker_summary),
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

function mapEvidence(row: Row): EvidenceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    requirementId: row.requirement_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    status: row.status,
    summary: safeText(row.summary),
    command: safeNullableText(row.command),
    exitCode: row.exit_code,
    rawLogRef: safeNullableText(row.raw_log_ref),
    artifactDigest: row.artifact_digest,
    producer: row.producer,
    provenance: row.provenance,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapReview(row: Row): ReviewRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    checkerAgentId: row.checker_agent_id,
    checkerSessionId: row.checker_session_id,
    artifactDigest: row.artifact_digest,
    verdict: row.verdict,
    summary: safeText(row.summary),
    requirementResults: redactValue(parseJson(row.requirement_results_json, [])).value,
    createdAt: row.created_at,
  };
}

function mapApproval(row: Row): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    status: row.status,
    requestedAction: safeText(row.requested_action),
    target: safeText(row.target),
    risk: row.risk,
    evidenceDigest: row.evidence_digest,
    makerSummary: safeText(row.maker_summary),
    checkerVerdict: row.checker_verdict,
    checkerSummary: safeText(row.checker_summary),
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: safeNullableText(row.decision_reason),
    version: row.version,
  };
}

function effectiveAgentStatus(row: Row): AgentRecord["status"] {
  if (!["starting", "running", "waiting"].includes(row.status)) return row.status;
  const heartbeatAt = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : Number.NaN;
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > AGENT_STALE_AFTER_MS) return "stale";
  return row.status;
}

function mapAgent(row: Row): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    runtime: row.runtime,
    model: row.model,
    status: effectiveAgentStatus(row),
    currentRunId: row.current_run_id,
    currentAction: safeNullableText(row.current_action),
    lastHeartbeatAt: row.last_heartbeat_at,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
  };
}

function mapWorktree(row: Row): WorktreeRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    path: row.path,
    branch: row.branch,
    commit: row.commit_hash,
    dirty: Boolean(row.dirty),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapArtifact(row: Row): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    name: row.name,
    kind: row.kind,
    uri: row.uri,
    digest: row.digest,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    producer: row.producer,
    verificationStatus: row.verification_status,
    sensitivity: row.sensitivity,
  };
}

function mapEvent(row: Row): EventRecord {
  const message = redactText(row.message);
  const rawPayload = parseJson<Record<string, unknown>>(row.payload_json, {});
  const payload = redactValue(rawPayload);
  if (typeof rawPayload.tokensUsed === "number") payload.value.tokensUsed = rawPayload.tokensUsed;
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    stageId: row.stage_id,
    attemptId: row.attempt_id,
    type: row.type,
    severity: row.severity,
    message: message.value,
    payload: payload.value,
    provenance: row.provenance,
    actor: row.actor,
    correlationId: row.correlation_id,
    artifactDigest: row.artifact_digest,
    redacted: Boolean(row.redacted) || message.redacted || payload.redacted,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
  };
}

function mapAudit(row: Row): AuditRecord {
  return {
    id: row.id,
    runId: row.run_id,
    actor: row.actor,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: safeNullableText(row.reason),
    metadata: redactValue(parseJson(row.metadata_json, {})).value,
    createdAt: row.created_at,
  };
}

const RUN_SELECT = `
  SELECT r.*, l.name AS loop_name, s.name AS current_stage_name,
    COUNT(DISTINCT req.id) AS requirement_total,
    COUNT(DISTINCT CASE WHEN req.status = 'pass' THEN req.id END) AS requirement_passed,
    COUNT(DISTINCT CASE WHEN req.status = 'fail' THEN req.id END) AS requirement_failed,
    COUNT(DISTINCT CASE WHEN req.status = 'missing' THEN req.id END) AS requirement_missing
  FROM runs r
  JOIN loops l ON l.id = r.loop_id
  LEFT JOIN stages s ON s.id = r.current_stage_id
  LEFT JOIN requirements req ON req.run_id = r.id AND req.superseded_at IS NULL
`;

export interface RunFilters {
  status?: string;
  statuses?: string[];
  loopId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

type CheckerVerdictRequest = CheckerVerdictInput & {
  requirementResults: ReviewRecord["requirementResults"];
};

interface RuntimeFactProjection {
  recordType: string;
  recordId: string;
  stageId?: string;
  attemptId?: string;
  actor: string;
  message: string;
  severity?: EventRecord["severity"];
  artifactDigest?: string;
  payload?: Record<string, unknown>;
  eventType?: string;
}

export class ControlPlaneStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly eventHub: EventHub,
  ) {}

  listLoops(): LoopDefinition[] {
    return (this.db.prepare("SELECT * FROM loops ORDER BY enabled DESC, name").all() as Row[]).map(mapLoop);
  }

  getGlobalPause(): { paused: boolean; version: number; changedAt: string; changedBy: string; reason: string } {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'global_pause%'").all() as Row[];
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value])) as Record<string, string>;
    return {
      paused: settings.global_pause === "true",
      version: Number(settings.global_pause_version ?? 1),
      changedAt: settings.global_pause_changed_at ?? now(),
      changedBy: settings.global_pause_changed_by ?? "system",
      reason: safeText(settings.global_pause_reason ?? "Initial local state"),
    };
  }

  setGlobalPause(
    input: { paused: boolean; reason: string; expectedVersion: number },
    actor: Actor,
  ): { paused: boolean; version: number; changedAt: string; changedBy: string; reason: string } {
    const current = this.getGlobalPause();
    if (current.version !== input.expectedVersion) {
      throw conflict("STALE_GLOBAL_PAUSE", "Global pause state changed before this update", { current });
    }
    if (current.paused === input.paused) {
      throw conflict("NO_STATE_CHANGE", `Global pause is already ${input.paused ? "enabled" : "disabled"}`, { current });
    }
    const timestamp = now();
    const reason = safeText(input.reason);
    transaction(this.db, () => {
      const liveVersion = Number((this.db.prepare("SELECT value FROM settings WHERE key = 'global_pause_version'").get() as Row).value);
      if (liveVersion !== input.expectedVersion) {
        throw conflict("STALE_GLOBAL_PAUSE", "Global pause state changed before this update", { current: this.getGlobalPause() });
      }
      const upsert = this.db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      upsert.run("global_pause", input.paused ? "true" : "false");
      upsert.run("global_pause_version", String(liveVersion + 1));
      upsert.run("global_pause_changed_at", timestamp);
      upsert.run("global_pause_changed_by", actor.id);
      upsert.run("global_pause_reason", reason);
      this.insertAuditUnsafe(actor, input.paused ? "workspace.pause" : "workspace.resume", "workspace", "local",
        reason, { from: current.paused, to: input.paused, expectedVersion: input.expectedVersion }, null);
    });
    return this.getGlobalPause();
  }

  getLoop(id: string): LoopDefinition {
    const row = this.db.prepare("SELECT * FROM loops WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Loop", id);
    return mapLoop(row);
  }

  listRuns(filters: RunFilters = {}): RunRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      where.push("r.status = ?");
      params.push(filters.status);
    } else if (filters.statuses?.length) {
      where.push(`r.status IN (${filters.statuses.map(() => "?").join(",")})`);
      params.push(...filters.statuses);
    }
    if (filters.loopId) {
      where.push("r.loop_id = ?");
      params.push(filters.loopId);
    }
    if (filters.query) {
      where.push("(r.goal LIKE ? OR r.id LIKE ? OR l.name LIKE ?)");
      const query = `%${filters.query}%`;
      params.push(query, query, query);
    }
    params.push(Math.min(Math.max(filters.limit ?? 100, 1), 500), Math.max(filters.offset ?? 0, 0));
    const sql = `${RUN_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY r.id ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(mapRun);
  }

  getRun(id: string): RunRecord {
    const row = this.db.prepare(`${RUN_SELECT} WHERE r.id = ? GROUP BY r.id`).get(id) as Row | undefined;
    if (!row) throw notFound("Run", id);
    return mapRun(row);
  }

  getRunDetail(id: string): RunDetailResponse {
    const run = this.getRun(id);
    const all = <T>(sql: string, mapper: (row: Row) => T): T[] =>
      (this.db.prepare(sql).all(id) as Row[]).map(mapper);
    return {
      run,
      stages: all("SELECT * FROM stages WHERE run_id = ? ORDER BY position", mapStage),
      attempts: all("SELECT * FROM attempts WHERE run_id = ? ORDER BY started_at, number", mapAttempt),
      requirements: all("SELECT * FROM requirements WHERE run_id = ? ORDER BY revision, position", mapRequirement),
      evidence: all("SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at", mapEvidence),
      reviews: all("SELECT * FROM reviews WHERE run_id = ? ORDER BY created_at", mapReview),
      verifications: (this.db.prepare(`SELECT v.* FROM verifications v JOIN attempts a ON a.id = v.attempt_id
        WHERE a.run_id = ? ORDER BY a.number, v.rowid`).all(id) as Row[]).map(mapVerification),
      approvals: all("SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at DESC", mapApproval),
      artifacts: all("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC", mapArtifact),
      worktrees: all("SELECT * FROM worktrees WHERE run_id = ? ORDER BY created_at DESC", mapWorktree),
      events: this.listEvents({ runId: id, limit: 500, latest: true }),
      agents: all("SELECT * FROM agents WHERE current_run_id = ? ORDER BY role, name", mapAgent),
      audit: all("SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at DESC", mapAudit),
    };
  }

  listEvents(filters: { runId?: string; after?: number; through?: number; limit?: number; latest?: boolean } = {}): EventRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.runId) {
      where.push("run_id = ?");
      params.push(filters.runId);
    }
    if (filters.after !== undefined) {
      if (!filters.runId) throw new HttpError(400, "RUN_ID_REQUIRED", "runId is required when filtering by sequence");
      where.push("sequence > ?");
      params.push(filters.after);
    }
    if (filters.through !== undefined) {
      if (!filters.runId) throw new HttpError(400, "RUN_ID_REQUIRED", "runId is required when filtering by sequence");
      where.push("sequence <= ?");
      params.push(filters.through);
    }
    params.push(Math.min(Math.max(filters.limit ?? 200, 1), 2_000));
    const order = filters.runId ? filters.latest ? "sequence DESC" : "sequence ASC" : "received_at DESC, row_number DESC";
    const events = (this.db.prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order} LIMIT ?`).all(...params) as Row[]).map(mapEvent);
    return filters.latest ? events.reverse() : events;
  }

  getEventPage(runId: string, after = 0, limit = 200): {
    items: EventRecord[];
    page: { after: number; nextAfter: number; limit: number; hasMore: boolean; availableFrom: number | null; availableThrough: number | null };
  } {
    const safeLimit = Math.min(Math.max(limit, 1), 1_999);
    const events = this.listEvents({ runId, after, limit: safeLimit + 1 });
    const items = events.slice(0, safeLimit);
    const bounds = this.getEventBounds(runId);
    return {
      items,
      page: {
        after,
        nextAfter: items.at(-1)?.sequence ?? after,
        limit: safeLimit,
        hasMore: events.length > safeLimit,
        availableFrom: bounds.first,
        availableThrough: bounds.last,
      },
    };
  }

  getEventBounds(runId: string): { first: number | null; last: number | null } {
    this.getRun(runId);
    const row = this.db.prepare("SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM events WHERE run_id = ?").get(runId) as Row;
    return { first: row.first ?? null, last: row.last ?? null };
  }

  listApprovals(status?: string): ApprovalRecord[] {
    this.expireApprovals();
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY requested_at DESC").all();
    return (rows as Row[]).map(mapApproval);
  }

  listAgents(): AgentRecord[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY status, role, name").all() as Row[]).map(mapAgent);
  }

  listArtifacts(runId?: string): ArtifactRecord[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC").all(runId)
      : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all();
    return (rows as Row[]).map(mapArtifact);
  }

  listWorktrees(runId?: string): WorktreeRecord[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM worktrees WHERE run_id = ? ORDER BY updated_at DESC").all(runId)
      : this.db.prepare("SELECT * FROM worktrees ORDER BY updated_at DESC").all();
    return (rows as Row[]).map(mapWorktree);
  }

  listAudit(runId?: string, limit = 250): AuditRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 2_000);
    const rows = runId
      ? this.db.prepare("SELECT * FROM audit_log WHERE run_id = ? ORDER BY row_number DESC LIMIT ?").all(runId, safeLimit)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY row_number DESC LIMIT ?").all(safeLimit);
    return (rows as Row[]).map(mapAudit);
  }

  overview(): OverviewResponse {
    this.expireApprovals();
    const activeStatuses = ["queued", "running", "waiting", "paused", "blocked"];
    const activeRuns = this.listRuns({ statuses: activeStatuses, limit: 100 });
    const loops = this.listLoops();
    const pendingApprovals = Number((this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'").get() as Row).count);
    const openBreakers = Number((this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE breaker_status = 'open'").get() as Row).count);
    const agents = this.listAgents();
    const staleAgents = agents.filter((agent) => agent.status === "stale").length;
    const activeRunCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM runs
      WHERE status IN ('queued','running','waiting','paused','blocked')`).get() as Row).count);
    const waitingRunCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM runs
      WHERE status IN ('waiting','paused','blocked')`).get() as Row).count);
    const outcomeMetrics = this.db.prepare(`SELECT COUNT(*) AS total_runs,
      SUM(CASE WHEN status IN ('succeeded','failed','timed_out','cancelled','capped') THEN 1 ELSE 0 END) AS terminal_runs,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_runs
      FROM runs`).get() as Row;
    const terminalRuns = Number(outcomeMetrics.terminal_runs ?? 0);
    const succeededRuns = Number(outcomeMetrics.succeeded_runs ?? 0);
    const latestEvent = this.db.prepare("SELECT MAX(received_at) AS at FROM events").get() as Row;
    const hasManagedRuns = Number((this.db.prepare("SELECT EXISTS(SELECT 1 FROM runs WHERE source_mode = 'managed') AS value").get() as Row).value) === 1;
    const globalPause = this.getGlobalPause().paused;
    const attention: OverviewResponse["attention"] = [];

    for (const approval of this.listApprovals("pending")) {
      attention.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        severity: approval.risk === "critical" ? "critical" : "warning",
        title: `Approval required: ${approval.requestedAction}`,
        detail: `${approval.target} · expires ${approval.expiresAt}`,
        runId: approval.runId,
        createdAt: approval.requestedAt,
      });
    }
    for (const run of activeRuns) {
      if (run.breaker.status === "open") attention.push({
        id: `breaker:${run.id}`,
        kind: "breaker",
        severity: "critical",
        title: `Circuit breaker open for ${run.loopName}`,
        detail: run.breaker.trigger ?? "Manual investigation required",
        runId: run.id,
        createdAt: run.breaker.openedAt ?? run.updatedAt,
      });
      const budgetPercent = run.budget.tokenLimit > 0 ? run.budget.tokensUsed / run.budget.tokenLimit * 100 : 0;
      if (budgetPercent >= run.budget.warningPercent) attention.push({
        id: `budget:${run.id}`,
        kind: "budget",
        severity: budgetPercent >= 100 ? "critical" : "warning",
        title: `Budget ${Math.round(budgetPercent)}% consumed`,
        detail: `${run.budget.tokensUsed.toLocaleString()} / ${run.budget.tokenLimit.toLocaleString()} tokens`,
        runId: run.id,
        createdAt: run.updatedAt,
      });
    }
    for (const agent of agents.filter((item) => item.status === "stale")) attention.push({
      id: `agent:${agent.id}`,
      kind: "stale_agent",
      severity: "warning",
      title: `${agent.name} stopped reporting`,
      detail: agent.lastHeartbeatAt ? `Last heartbeat ${agent.lastHeartbeatAt}` : "No heartbeat received",
      runId: agent.currentRunId,
      createdAt: agent.lastHeartbeatAt ?? now(),
    });

    return {
      generatedAt: now(),
      connection: {
        mode: hasManagedRuns ? "managed" : "snapshot",
        status: latestEvent.at ? "connected" : "degraded",
        lastEventAt: latestEvent.at ?? null,
        globalPause,
      },
      counts: {
        activeRuns: activeRunCount,
        waitingRuns: waitingRunCount,
        pendingApprovals,
        openBreakers,
        staleAgents,
      },
      metrics: {
        totalRuns: Number(outcomeMetrics.total_runs ?? 0),
        terminalRuns,
        succeededRuns,
        unsuccessfulRuns: terminalRuns - succeededRuns,
        successRatePct: terminalRuns === 0 ? null : Math.round(succeededRuns / terminalRuns * 1_000) / 10,
      },
      attention: attention.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      activeRuns,
      loops,
      recentEvents: this.listEvents({ limit: 30 }),
    };
  }

  createRun(input: CreateRunInput, actor: Actor): RunRecord {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const loop = this.getLoop(input.loopId);
    if (!loop.enabled) throw conflict("LOOP_DISABLED", "The selected loop is disabled");
    const globalPause = (this.db.prepare("SELECT value FROM settings WHERE key = 'global_pause'").get() as Row | undefined)?.value === "true";
    if (globalPause) throw conflict("GLOBAL_PAUSE", "New runs are disabled while global pause is active");

    const event = transaction(this.db, () => {
      const safeGoal = redactText(input.goal).value;
      const safeProjectName = redactText(input.projectName).value;
      this.db.prepare(`INSERT INTO runs(
        id, loop_id, project_name, repository_path, runtime, model, goal, status, automation_level, risk, updated_at, source_mode,
        token_limit, cost_limit_usd, iteration_limit, warning_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.loopId, safeProjectName, input.repositoryPath ?? null, input.runtime, input.model,
          safeGoal, input.automationLevel, input.risk, timestamp, input.sourceMode,
          input.budget.tokenLimit, input.budget.costLimitUsd, input.budget.iterationLimit, input.budget.warningPercent);
      const insertStage = this.db.prepare(`INSERT INTO stages(id, run_id, key, name, position, role, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`);
      input.stages.forEach((stage, position) => insertStage.run(randomUUID(), id, stage.key, stage.name, position, stage.role));
      const insertRequirement = this.db.prepare(`INSERT INTO requirements(id, run_id, revision, position, title,
        description, acceptance_criteria, status, content_hash, evidence_ids_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'pending', ?, '[]', ?)`);
      input.requirements.forEach((requirement, position) => {
        const safeRequirement = {
          title: redactText(requirement.title).value,
          description: redactText(requirement.description).value,
          acceptanceCriteria: redactText(requirement.acceptanceCriteria).value,
        };
        const contentHash = createHash("sha256").update(JSON.stringify(safeRequirement)).digest("hex");
        insertRequirement.run(randomUUID(), id, position, safeRequirement.title, safeRequirement.description,
          safeRequirement.acceptanceCriteria, contentHash, timestamp);
      });
      this.insertAuditUnsafe(actor, "run.create", "run", id, null, { loopId: input.loopId });
      return this.insertEventUnsafe({
        runId: id,
        type: "run.created",
        severity: "info",
        message: `Run queued for ${loop.name}`,
        payload: { goal: safeGoal, stageCount: input.stages.length },
        provenance: "human",
        actor: actor.id,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    return this.getRun(id);
  }

  applyRunAction(runId: string, input: RunActionInput, actor: Actor): RunRecord {
    const current = this.getRun(runId);
    if (current.sourceMode === "snapshot") throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
    if (input.expectedStatus && input.expectedStatus !== current.status) {
      throw conflict("STALE_RUN", `Run changed from ${input.expectedStatus} to ${current.status}`, { current });
    }
    if (input.action === "retry") return this.retryRun(current, actor, input.reason);
    if (isTerminalRun(current.status)) {
      throw conflict("TERMINAL_RUN", `Run in '${current.status}' is immutable; create a retry run instead`);
    }
    if (actionRequiresReason(input.action) && !input.reason?.trim()) {
      throw new HttpError(400, "REASON_REQUIRED", `A reason is required to ${input.action.replaceAll("_", " ")}`);
    }

    const target: Partial<Record<RunActionInput["action"], RunStatus>> = {
      start: "running",
      pause: "paused",
      resume: "running",
      cancel: "cancelled",
    };
    const nextStatus = target[input.action];
    if (input.action === "override_breaker") {
      if (current.breaker.status !== "open") throw conflict("BREAKER_NOT_OPEN", "Only an open breaker can be overridden");
      const event = transaction(this.db, () => {
        this.db.prepare(`UPDATE runs SET breaker_status = 'overridden', breaker_overridden_by = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND breaker_status = 'open'`).run(actor.id, now(), runId);
        this.insertAuditUnsafe(actor, "breaker.override", "run", runId, input.reason ?? null, {
          trigger: current.breaker.trigger,
          errorSignature: current.breaker.errorSignature,
        });
        return this.insertEventUnsafe({
          runId,
          type: "breaker.overridden",
          severity: "warning",
          message: `Circuit breaker overridden by ${actor.id}`,
          payload: { reason: input.reason },
          provenance: "human",
          actor: actor.id,
          occurredAt: now(),
        });
      });
      this.eventHub.publish(event);
      return this.getRun(runId);
    }
    if (!nextStatus) throw new HttpError(400, "UNKNOWN_ACTION", `Unknown run action '${input.action}'`);
    try {
      assertRunTransition(current.status, nextStatus);
    } catch (error) {
      throw conflict("INVALID_TRANSITION", error instanceof Error ? error.message : "Invalid run transition");
    }
    if (nextStatus === "running" && current.breaker.status === "open") {
      throw conflict("BREAKER_OPEN", "Override the circuit breaker before resuming this run");
    }
    if (nextStatus === "running" && this.getGlobalPause().paused) {
      throw conflict("GLOBAL_PAUSE", "Start and resume are disabled while global pause is active");
    }
    if (nextStatus === "running" && (current.budget.tokensUsed >= current.budget.tokenLimit
      || current.budget.iterationsUsed >= current.budget.iterationLimit
      || (current.budget.costLimitUsd > 0 && current.budget.costUsedUsd >= current.budget.costLimitUsd))) {
      throw conflict("BUDGET_EXHAUSTED", "Increase the bounded budget or create a reviewed retry before continuing");
    }
    const timestamp = now();
    const event = transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE runs SET status = ?,
        started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? IN ('succeeded','failed','timed_out','cancelled','capped') THEN ? ELSE NULL END,
        waiting_reason = NULL, blocked_owner = NULL, unblock_condition = NULL,
        updated_at = ?, version = version + 1 WHERE id = ? AND status = ?`)
        .run(nextStatus, nextStatus, timestamp, nextStatus, timestamp, timestamp, runId, current.status);
      if (result.changes !== 1) throw conflict("STALE_RUN", "Run status changed before the action could be applied");
      this.insertAuditUnsafe(actor, `run.${input.action}`, "run", runId, input.reason ?? null, {
        from: current.status,
        to: nextStatus,
      });
      return this.insertEventUnsafe({
        runId,
        type: `run.${input.action}`,
        severity: input.action === "cancel" ? "warning" : "info",
        message: `Run ${input.action === "start" ? "started" : `${input.action}d`}`,
        payload: { from: current.status, to: nextStatus, reason: input.reason },
        provenance: "human",
        actor: actor.id,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    return this.getRun(runId);
  }

  transitionRun(
    runId: string,
    input: {
      status: RunStatus;
      reason?: string;
      expectedStatus?: RunStatus;
      blockedOwner?: string;
      unblockCondition?: string;
    },
    actor: Actor,
  ): RunRecord {
    const current = this.getRun(runId);
    if (current.sourceMode === "snapshot") throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
    if (input.expectedStatus && input.expectedStatus !== current.status) {
      throw conflict("STALE_RUN", `Run changed from ${input.expectedStatus} to ${current.status}`, { current });
    }
    if (isTerminalRun(current.status)) {
      throw conflict("TERMINAL_RUN", `Run in '${current.status}' is immutable; create a retry run instead`);
    }
    if (["waiting", "blocked", "failed", "timed_out", "cancelled", "capped"].includes(input.status) && !input.reason?.trim()) {
      throw new HttpError(400, "REASON_REQUIRED", `${input.status} requires a reason`);
    }
    if (input.status === "blocked" && (!input.blockedOwner?.trim() || !input.unblockCondition?.trim())) {
      throw new HttpError(400, "BLOCK_DETAILS_REQUIRED", "A blocked run requires blockedOwner and unblockCondition");
    }
    if (input.status === "running" && current.breaker.status === "open") {
      throw conflict("BREAKER_OPEN", "Override the circuit breaker before resuming this run");
    }
    if (input.status === "running" && this.getGlobalPause().paused) {
      throw conflict("GLOBAL_PAUSE", "Start and resume are disabled while global pause is active");
    }
    if (input.status === "running" && (current.budget.tokensUsed >= current.budget.tokenLimit
      || current.budget.iterationsUsed >= current.budget.iterationLimit
      || (current.budget.costLimitUsd > 0 && current.budget.costUsedUsd >= current.budget.costLimitUsd))) {
      throw conflict("BUDGET_EXHAUSTED", "Increase the bounded budget or create a reviewed retry before continuing");
    }
    try {
      assertRunTransition(current.status, input.status);
    } catch (error) {
      throw conflict("INVALID_TRANSITION", error instanceof Error ? error.message : "Invalid run transition");
    }
    const timestamp = now();
    const safeReason = input.reason ? redactText(input.reason).value : undefined;
    const safeBlockedOwner = input.blockedOwner ? redactText(input.blockedOwner).value : undefined;
    const safeUnblockCondition = input.unblockCondition ? redactText(input.unblockCondition).value : undefined;
    const event = transaction(this.db, () => {
      const lockedCurrent = this.getRun(runId);
      if (lockedCurrent.status !== current.status) {
        throw conflict("STALE_RUN", `Run changed from ${current.status} to ${lockedCurrent.status}`, { current: lockedCurrent });
      }
      if (input.status === "succeeded") {
        const detail = this.getRunDetail(runId);
        const currentAttempt = [...detail.attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
        try {
          assertRunCanSucceed({
            requirements: detail.requirements,
            evidence: detail.evidence,
            reviews: detail.reviews,
            currentAttempt,
          });
        } catch (error) {
          throw new HttpError(422, "COMPLETION_GUARD", error instanceof Error ? error.message : "Completion evidence is incomplete");
        }
        const requiresHumanGate = detail.stages.some((stage) => stage.role === "human" && stage.status !== "skipped");
        if (requiresHumanGate) {
          const digest = currentAttempt?.artifactDigest;
          const validApproval = detail.approvals.find((approval) =>
            approval.status === "approved"
            && approval.evidenceDigest === digest
            && Date.parse(approval.expiresAt) > Date.now());
          if (!validApproval) {
            throw new HttpError(422, "COMPLETION_GUARD", "No current, unexpired human approval is bound to the reviewed artifact digest");
          }
        }
        const incompleteStages = detail.stages.filter((stage) => !["passed", "skipped"].includes(stage.status));
        if (incompleteStages.length > 0) {
          throw new HttpError(422, "COMPLETION_GUARD",
            `Run cannot succeed while stages remain incomplete: ${incompleteStages.map((stage) => stage.key).join(", ")}`);
        }
      }
      const terminal = ["succeeded", "failed", "timed_out", "cancelled", "capped"].includes(input.status);
      const result = this.db.prepare(`UPDATE runs SET status = ?,
        waiting_reason = CASE WHEN ? = 'waiting' THEN ? ELSE NULL END,
        blocked_owner = CASE WHEN ? = 'blocked' THEN ? ELSE NULL END,
        unblock_condition = CASE WHEN ? = 'blocked' THEN ? ELSE NULL END,
        started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? THEN ? ELSE NULL END,
        updated_at = ?, version = version + 1 WHERE id = ? AND status = ?`)
        .run(input.status, input.status, safeReason ?? null,
          input.status, safeBlockedOwner ?? null, input.status, safeUnblockCondition ?? null,
          input.status, timestamp, terminal ? 1 : 0, timestamp, timestamp, runId, lockedCurrent.status);
      if (result.changes !== 1) throw conflict("STALE_RUN", "Run changed before the transition could be applied");
      this.insertAuditUnsafe(actor, "run.transition", "run", runId, safeReason ?? null, {
        from: lockedCurrent.status,
        to: input.status,
        blockedOwner: safeBlockedOwner,
        unblockCondition: safeUnblockCondition,
      });
      return this.insertEventUnsafe({
        runId,
        type: "run.transitioned",
        severity: ["failed", "timed_out", "capped", "blocked"].includes(input.status) ? "warning" : "info",
        message: `Run transitioned from ${lockedCurrent.status} to ${input.status}`,
        payload: { ...input, reason: safeReason, blockedOwner: safeBlockedOwner, unblockCondition: safeUnblockCondition, from: lockedCurrent.status },
        provenance: actor.id === "runtime" ? "runtime" : "human",
        actor: actor.id,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    return this.getRun(runId);
  }

  transitionStage(runId: string, stageId: string, status: StageStatus, reason: string | undefined, actor: Actor): StageRecord {
    const run = this.getRun(runId);
    if (run.sourceMode === "snapshot") throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
    if (isTerminalRun(run.status)) {
      throw conflict("TERMINAL_RUN", `Stages cannot be mutated after run '${runId}' reaches '${run.status}'`);
    }
    if ((run.breaker.status === "open" || run.status === "blocked") && !["failed", "blocked"].includes(status)) {
      throw conflict("BREAKER_OPEN", "Stage progress is stopped until the circuit breaker is overridden and the run resumes");
    }
    const row = this.db.prepare("SELECT * FROM stages WHERE id = ? AND run_id = ?").get(stageId, runId) as Row | undefined;
    if (!row) throw notFound("Stage", stageId);
    const current = mapStage(row);
    if (["passed", "rejected", "failed", "skipped"].includes(current.status)) {
      throw conflict("TERMINAL_STAGE", `Stage in '${current.status}' is immutable`);
    }
    if ((status === "waiting" || status === "blocked" || status === "skipped") && !reason?.trim()) {
      throw new HttpError(400, "REASON_REQUIRED", `${status} stage requires a reason`);
    }
    try {
      assertStageTransition(current.status, status);
    } catch (error) {
      throw conflict("INVALID_TRANSITION", error instanceof Error ? error.message : "Invalid stage transition");
    }
    const timestamp = now();
    const safeReason = reason ? redactText(reason).value : undefined;
    const terminal = ["passed", "rejected", "failed", "skipped"].includes(status);
    const duration = terminal && current.startedAt ? Math.max(Date.parse(timestamp) - Date.parse(current.startedAt), 0) : null;
    const event = transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE stages SET status = ?,
        started_at = CASE WHEN ? = 'active' AND started_at IS NULL THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
        duration_ms = COALESCE(?, duration_ms),
        waiting_reason = CASE WHEN ? IN ('waiting','blocked') THEN ? ELSE NULL END,
        skip_reason = CASE WHEN ? = 'skipped' THEN ? ELSE skip_reason END,
        version = version + 1 WHERE id = ? AND run_id = ? AND status = ?`)
        .run(status, status, timestamp, terminal ? 1 : 0, timestamp, duration,
          status, safeReason ?? null, status, safeReason ?? null, stageId, runId, current.status);
      if (result.changes !== 1) throw conflict("STALE_STAGE", "Stage changed before the transition could be applied");
      this.db.prepare(`UPDATE runs SET current_stage_id = CASE WHEN ? IN ('active','waiting','blocked') THEN ? ELSE current_stage_id END,
        updated_at = ?, version = version + 1 WHERE id = ?`).run(status, stageId, timestamp, runId);
      this.insertAuditUnsafe(actor, "stage.transition", "stage", stageId, safeReason ?? null, { from: current.status, to: status });
      return this.insertEventUnsafe({
        runId,
        stageId,
        type: "stage.transitioned",
        severity: status === "failed" || status === "blocked" ? "warning" : "info",
        message: `${current.name}: ${current.status} → ${status}`,
        payload: { from: current.status, to: status, reason: safeReason },
        provenance: actor.id === "runtime" ? "runtime" : "human",
        actor: actor.id,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    const updated = this.db.prepare("SELECT * FROM stages WHERE id = ?").get(stageId) as Row;
    return mapStage(updated);
  }

  ingestRuntimeFact(runId: string, fact: RuntimeFactInput, actor: Actor): RuntimeFactReceipt {
    const payloadHash = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
    const outcome = transaction(this.db, () => {
      const existing = this.db.prepare(`SELECT f.*, e.sequence AS event_sequence FROM runtime_facts f
        JOIN events e ON e.id = f.event_id WHERE f.id = ?`).get(fact.id) as Row | undefined;
      if (existing) {
        if (existing.run_id !== runId || existing.payload_hash !== payloadHash) {
          throw conflict("FACT_ID_CONFLICT", `Runtime fact '${fact.id}' was already used with different content`);
        }
        return {
          receipt: this.mapRuntimeFactReceipt(existing, true),
          events: [] as EventRecord[],
        };
      }

      const runRow = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row | undefined;
      if (!runRow) throw notFound("Run", runId);
      if (runRow.source_mode === "snapshot") throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
      if (isTerminalRun(runRow.status)) throw conflict("TERMINAL_RUN", "Runtime facts cannot mutate a terminal run");
      const heartbeat = fact.type === "agent.heartbeat";
      const terminalReport = fact.type === "attempt.finished";
      if (runRow.breaker_status === "open" && !heartbeat && !terminalReport) {
        throw conflict("BREAKER_OPEN", "Runtime progress is stopped while the circuit breaker is open");
      }
      const allowedStatuses = heartbeat
        ? ["running", "waiting", "paused", "blocked"]
        : terminalReport
          ? ["running", "waiting", "blocked"]
          : fact.type === "approval.requested"
            ? ["running", "waiting"]
            : ["running"];
      if (!allowedStatuses.includes(runRow.status)) {
        throw conflict("RUN_NOT_ACTIVE", `Run must be started before accepting runtime facts; current status is '${runRow.status}'`);
      }

      const acceptedAt = now();
      const occurredAt = fact.occurredAt ?? acceptedAt;
      const projection = this.applyRuntimeFactUnsafe(runId, fact, acceptedAt);
      const event = this.insertEventUnsafe({
        runId,
        stageId: projection.stageId,
        attemptId: projection.attemptId,
        type: projection.eventType ?? fact.type,
        severity: projection.severity ?? "info",
        message: projection.message,
        payload: { factId: fact.id, ...(projection.payload ?? {}) },
        provenance: "runtime",
        actor: projection.actor,
        artifactDigest: projection.artifactDigest,
        occurredAt,
      });
      this.insertAuditUnsafe(actor, `runtime_fact.${fact.type}`, projection.recordType, projection.recordId, null, {
        factId: fact.id,
        eventId: event.id,
        artifactDigest: projection.artifactDigest,
      }, runId);
      this.db.prepare(`INSERT INTO runtime_facts(id, run_id, type, payload_hash, record_type, record_id, event_id, accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(fact.id, runId, fact.type, payloadHash, projection.recordType,
        projection.recordId, event.id, acceptedAt);
      const derived = this.applyTelemetryUnsafe(event);
      return {
        receipt: {
          id: fact.id,
          runId,
          type: fact.type,
          recordType: projection.recordType,
          recordId: projection.recordId,
          eventId: event.id,
          eventSequence: event.sequence,
          acceptedAt,
          idempotent: false,
        } satisfies RuntimeFactReceipt,
        events: [event, ...derived],
      };
    });
    for (const event of outcome.events) this.eventHub.publish(event);
    return outcome.receipt;
  }

  private applyRuntimeFactUnsafe(runId: string, fact: RuntimeFactInput, acceptedAt: string): RuntimeFactProjection {
    switch (fact.type) {
      case "agent.heartbeat": {
        const existing = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(fact.agentId) as Row | undefined;
        const currentAction = fact.currentAction === null ? null : safeText(fact.currentAction);
        const worktreePath = fact.worktreePath === null ? null : safeText(fact.worktreePath);
        if (existing) {
          if (existing.current_run_id !== runId || existing.session_id !== fact.sessionId || existing.role !== fact.role) {
            throw new HttpError(422, "AGENT_IDENTITY", "Agent ID, run, role, and session form an immutable identity");
          }
          if (["finished", "error"].includes(existing.status)) {
            throw conflict("AGENT_SESSION_TERMINAL", `Agent session is already '${existing.status}'`);
          }
          this.db.prepare(`UPDATE agents SET name = ?, runtime = ?, model = ?, status = ?, current_action = ?,
            last_heartbeat_at = ?, worktree_path = ? WHERE id = ? AND current_run_id = ? AND session_id = ?`)
            .run(safeText(fact.name), fact.runtime, fact.model, fact.status, currentAction, acceptedAt,
              worktreePath, fact.agentId, runId, fact.sessionId);
        } else {
          this.db.prepare(`INSERT INTO agents(id, name, role, runtime, model, status, current_run_id, current_action,
            last_heartbeat_at, session_id, worktree_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(fact.agentId, safeText(fact.name), fact.role, fact.runtime, fact.model, fact.status, runId,
              currentAction, acceptedAt, fact.sessionId, worktreePath);
        }
        return {
          recordType: "agent",
          recordId: fact.agentId,
          actor: fact.agentId,
          message: `${safeText(fact.name)} heartbeat: ${fact.status}`,
          payload: { role: fact.role, status: fact.status, sessionId: fact.sessionId },
        };
      }
      case "attempt.started": {
        const stage = this.requireStageUnsafe(runId, fact.stageId);
        if (stage.role !== "maker" || stage.status !== "active") {
          throw new HttpError(422, "INVALID_ATTEMPT_STAGE", "A maker attempt requires an active maker stage");
        }
        this.requireRuntimeAgentUnsafe(runId, fact.makerAgentId, fact.makerSessionId, ["maker"]);
        if (this.db.prepare("SELECT 1 FROM attempts WHERE id = ?").get(fact.attemptId)) {
          throw conflict("RECORD_ID_CONFLICT", `Attempt '${fact.attemptId}' already exists`);
        }
        const nextNumber = Number((this.db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS number FROM attempts
          WHERE run_id = ? AND stage_id = ?`).get(runId, fact.stageId) as Row).number);
        const number = fact.number ?? nextNumber;
        if (number !== nextNumber) {
          throw conflict("ATTEMPT_NUMBER_CONFLICT", `The next immutable attempt number is ${nextNumber}`);
        }
        let resolvedFeedbackSummary = fact.feedbackSummary;
        if (nextNumber === 1) {
          if (fact.previousAttemptId || fact.feedbackReviewId || fact.feedbackSummary) {
            throw new HttpError(422, "INVALID_RETRY_LINEAGE", "The first attempt cannot reference retry feedback");
          }
        } else {
          const previous = fact.previousAttemptId
            ? this.db.prepare("SELECT * FROM attempts WHERE id = ? AND run_id = ? AND stage_id = ?")
              .get(fact.previousAttemptId, runId, fact.stageId) as Row | undefined
            : undefined;
          const latest = this.db.prepare(`SELECT * FROM attempts WHERE run_id = ? AND stage_id = ?
            ORDER BY number DESC LIMIT 1`).get(runId, fact.stageId) as Row;
          if (!previous || previous.id !== latest.id || previous.number !== number - 1 || !fact.feedbackSummary) {
            throw new HttpError(422, "RETRY_LINEAGE_REQUIRED", "A retry must link the immediately previous attempt and summarize its feedback");
          }
          if (["running", "success"].includes(previous.status)) {
            throw conflict("PREVIOUS_ATTEMPT_NOT_RETRYABLE", `Attempt '${previous.id}' is '${previous.status}'`);
          }
          const feedbackReview = fact.feedbackReviewId
            ? this.db.prepare("SELECT * FROM reviews WHERE id = ? AND run_id = ? AND attempt_id = ?")
              .get(fact.feedbackReviewId, runId, previous.id) as Row | undefined
            : undefined;
          if (fact.feedbackReviewId && !feedbackReview) {
            throw new HttpError(422, "INVALID_RETRY_LINEAGE", "Feedback review does not belong to the previous attempt");
          }
          if (["rejected", "escalated"].includes(previous.status) && !feedbackReview) {
            throw new HttpError(422, "RETRY_LINEAGE_REQUIRED", "A checker-rejected retry must link its feedback review");
          }
          if (feedbackReview) {
            const immutableSummary = safeText(feedbackReview.summary);
            if (fact.feedbackSummary !== immutableSummary) {
              throw new HttpError(422, "INVALID_RETRY_LINEAGE", "Retry feedback summary must exactly match the immutable checker review");
            }
            resolvedFeedbackSummary = immutableSummary;
          }
        }
        try {
          this.db.prepare(`INSERT INTO attempts(id, run_id, stage_id, number, status, maker_agent_id,
            maker_session_id, checker_status, previous_attempt_id, feedback_review_id, feedback_summary, started_at)
            VALUES (?, ?, ?, ?, 'running', ?, ?, 'pending', ?, ?, ?, ?)`)
            .run(fact.attemptId, runId, fact.stageId, number, fact.makerAgentId, fact.makerSessionId,
              fact.previousAttemptId, fact.feedbackReviewId,
              resolvedFeedbackSummary === null ? null : safeText(resolvedFeedbackSummary), acceptedAt);
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE")) {
            throw conflict("ATTEMPT_NUMBER_CONFLICT", `Attempt number ${number} already exists for this stage`);
          }
          throw error;
        }
        return {
          recordType: "attempt",
          recordId: fact.attemptId,
          stageId: fact.stageId,
          attemptId: fact.attemptId,
          actor: fact.makerAgentId,
          message: `Maker attempt ${number} started`,
          payload: {
            number,
            makerAgentId: fact.makerAgentId,
            previousAttemptId: fact.previousAttemptId,
            feedbackReviewId: fact.feedbackReviewId,
          },
        };
      }
      case "worktree.recorded": {
        const attempt = this.requireMakerAttemptUnsafe(runId, fact.attemptId, fact.makerAgentId, fact.makerSessionId);
        if (attempt.status !== "running") throw conflict("ATTEMPT_IMMUTABLE", "A finished attempt's worktree cannot be changed");
        const existing = this.db.prepare("SELECT * FROM worktrees WHERE id = ?").get(fact.worktreeId) as Row | undefined;
        let version: number;
        if (!existing) {
          if (fact.expectedVersion !== 0) throw conflict("STALE_WORKTREE", "A new worktree must use expectedVersion 0");
          this.db.prepare(`INSERT INTO worktrees(id, run_id, attempt_id, path, branch, commit_hash, dirty, status,
            created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
            .run(fact.worktreeId, runId, fact.attemptId, safeText(fact.path), safeText(fact.branch),
              fact.commit, fact.dirty ? 1 : 0, fact.status, acceptedAt, acceptedAt);
          version = 1;
        } else {
          if (existing.run_id !== runId || existing.attempt_id !== fact.attemptId) {
            throw new HttpError(422, "INVALID_REFERENCE", "Worktree does not belong to this run and attempt");
          }
          if (Number(existing.version) !== fact.expectedVersion) {
            throw conflict("STALE_WORKTREE", "Worktree changed before this update", { currentVersion: existing.version });
          }
          const result = this.db.prepare(`UPDATE worktrees SET path = ?, branch = ?, commit_hash = ?, dirty = ?,
            status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND run_id = ? AND version = ?`)
            .run(safeText(fact.path), safeText(fact.branch), fact.commit, fact.dirty ? 1 : 0, fact.status,
              acceptedAt, fact.worktreeId, runId, fact.expectedVersion);
          if (result.changes !== 1) throw conflict("STALE_WORKTREE", "Worktree changed before this update");
          version = fact.expectedVersion + 1;
        }
        this.db.prepare(`UPDATE attempts SET worktree_path = ?, branch = ?, version = version + 1
          WHERE id = ? AND run_id = ?`).run(safeText(fact.path), safeText(fact.branch), fact.attemptId, runId);
        return {
          recordType: "worktree",
          recordId: fact.worktreeId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.makerAgentId,
          message: `Worktree ${fact.status}: ${safeText(fact.branch)}`,
          payload: { branch: safeText(fact.branch), dirty: fact.dirty, status: fact.status, version },
        };
      }
      case "attempt.artifact": {
        const attempt = this.requireMakerAttemptUnsafe(runId, fact.attemptId, fact.makerAgentId, fact.makerSessionId);
        if (attempt.status !== "running" || attempt.checker_status !== "pending") {
          throw conflict("ATTEMPT_IMMUTABLE", "Artifact digest is immutable after the attempt reaches the checker");
        }
        const currentDigest = attempt.artifact_digest ?? null;
        if (currentDigest !== fact.expectedArtifactDigest) {
          throw conflict("STALE_ARTIFACT_DIGEST", "Attempt artifact changed before this update", { currentDigest });
        }
        if (currentDigest === fact.artifactDigest) throw conflict("NO_STATE_CHANGE", "Attempt already has this artifact digest");
        const result = this.db.prepare(`UPDATE attempts SET artifact_digest = ?, version = version + 1
          WHERE id = ? AND run_id = ? AND status = 'running' AND checker_status = 'pending' AND artifact_digest IS ?`)
          .run(fact.artifactDigest, fact.attemptId, runId, fact.expectedArtifactDigest);
        if (result.changes !== 1) throw conflict("STALE_ARTIFACT_DIGEST", "Attempt artifact changed before this update");
        return {
          recordType: "attempt",
          recordId: fact.attemptId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.makerAgentId,
          message: "Attempt artifact digest bound",
          artifactDigest: fact.artifactDigest,
        };
      }
      case "attempt.finished": {
        const attempt = this.requireMakerAttemptUnsafe(runId, fact.attemptId, fact.makerAgentId, fact.makerSessionId);
        if (attempt.status !== fact.expectedStatus) {
          throw conflict("STALE_ATTEMPT", `Attempt changed from ${fact.expectedStatus} to ${attempt.status}`);
        }
        const result = this.db.prepare(`UPDATE attempts SET status = ?, finished_at = ?, version = version + 1
          WHERE id = ? AND run_id = ? AND status = ?`).run(fact.status, acceptedAt, fact.attemptId, runId, fact.expectedStatus);
        if (result.changes !== 1) throw conflict("STALE_ATTEMPT", "Attempt changed before completion");
        return {
          recordType: "attempt",
          recordId: fact.attemptId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.makerAgentId,
          message: safeText(fact.summary),
          severity: fact.status === "failure" ? "error" : "warning",
          artifactDigest: attempt.artifact_digest ?? undefined,
          payload: { status: fact.status, errorSignature: fact.errorSignature },
          eventType: fact.status === "failure" ? "attempt.failed" : `attempt.${fact.status}`,
        };
      }
      case "verification.recorded": {
        const attempt = this.requireAttemptUnsafe(runId, fact.attemptId);
        if (attempt.status !== "running") throw conflict("ATTEMPT_IMMUTABLE", "Verification cannot be added to a finished attempt");
        this.requireRuntimeAgentUnsafe(runId, fact.agentId, fact.sessionId, ["maker", "system"]);
        this.assertAttemptDigest(attempt, fact.artifactDigest);
        if (fact.status === "passed" && fact.exitCode !== 0) {
          throw new HttpError(422, "INVALID_VERIFICATION", "A passed command verification must have exitCode 0");
        }
        if (this.db.prepare("SELECT 1 FROM verifications WHERE id = ?").get(fact.verificationId)) {
          throw conflict("RECORD_ID_CONFLICT", `Verification '${fact.verificationId}' already exists`);
        }
        this.db.prepare(`INSERT INTO verifications(id, attempt_id, name, command, status, exit_code, duration_ms,
          evidence_digest, output_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(fact.verificationId, fact.attemptId, safeText(fact.name), safeText(fact.command), fact.status,
            fact.exitCode, fact.durationMs, fact.evidenceDigest, fact.outputPreview === null ? null : safeText(fact.outputPreview));
        return {
          recordType: "verification",
          recordId: fact.verificationId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.agentId,
          message: `${safeText(fact.name)} ${fact.status}`,
          severity: fact.status === "failed" ? "error" : "info",
          artifactDigest: fact.artifactDigest,
          payload: { status: fact.status, exitCode: fact.exitCode, durationMs: fact.durationMs },
        };
      }
      case "requirement.evidence": {
        const attempt = this.requireAttemptUnsafe(runId, fact.attemptId);
        if (attempt.status !== "running") throw conflict("ATTEMPT_IMMUTABLE", "Evidence cannot be added to a finished attempt");
        this.requireRuntimeAgentUnsafe(runId, fact.agentId, fact.sessionId, ["maker", "system"]);
        this.assertAttemptDigest(attempt, fact.artifactDigest);
        const requirement = this.db.prepare(`SELECT * FROM requirements WHERE id = ? AND run_id = ?
          AND superseded_at IS NULL`).get(fact.requirementId, runId) as Row | undefined;
        if (!requirement) throw new HttpError(422, "INVALID_REFERENCE", "Requirement is not current for this run");
        if (fact.expiresAt && Date.parse(fact.expiresAt) <= Date.parse(acceptedAt)) {
          throw new HttpError(422, "EXPIRED_EVIDENCE", "Evidence must not be expired when it is recorded");
        }
        if (this.db.prepare("SELECT 1 FROM evidence WHERE id = ?").get(fact.evidenceId)) {
          throw conflict("RECORD_ID_CONFLICT", `Evidence '${fact.evidenceId}' already exists`);
        }
        this.db.prepare(`INSERT INTO evidence(id, run_id, requirement_id, attempt_id, kind, status, summary,
          command, exit_code, raw_log_ref, artifact_digest, producer, provenance, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(fact.evidenceId, runId, fact.requirementId, fact.attemptId, fact.kind, fact.status,
            safeText(fact.summary), fact.command === null ? null : safeText(fact.command), fact.exitCode,
            fact.rawLogRef === null ? null : safeText(fact.rawLogRef), fact.artifactDigest, fact.agentId,
            fact.provenance, acceptedAt, fact.expiresAt);
        return {
          recordType: "evidence",
          recordId: fact.evidenceId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.agentId,
          message: `Requirement evidence ${fact.status}: ${safeText(fact.summary)}`,
          severity: fact.status === "fail" ? "warning" : "info",
          artifactDigest: fact.artifactDigest,
          payload: { requirementId: fact.requirementId, evidenceId: fact.evidenceId, status: fact.status },
        };
      }
      case "artifact.recorded": {
        const attempt = this.requireAttemptUnsafe(runId, fact.attemptId);
        if (attempt.status !== "running") throw conflict("ATTEMPT_IMMUTABLE", "Artifacts cannot be added to a finished attempt");
        this.requireRuntimeAgentUnsafe(runId, fact.agentId, fact.sessionId, ["maker", "system"]);
        this.assertAttemptDigest(attempt, fact.digest);
        if (this.db.prepare("SELECT 1 FROM artifacts WHERE id = ?").get(fact.artifactId)) {
          throw conflict("RECORD_ID_CONFLICT", `Artifact '${fact.artifactId}' already exists`);
        }
        this.db.prepare(`INSERT INTO artifacts(id, run_id, attempt_id, name, kind, uri, digest, size_bytes,
          created_at, producer, verification_status, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(fact.artifactId, runId, fact.attemptId, safeText(fact.name), fact.kind, safeText(fact.uri),
            fact.digest, fact.sizeBytes, acceptedAt, fact.agentId, fact.verificationStatus, fact.sensitivity);
        return {
          recordType: "artifact",
          recordId: fact.artifactId,
          stageId: attempt.stage_id,
          attemptId: fact.attemptId,
          actor: fact.agentId,
          message: `Artifact recorded: ${safeText(fact.name)}`,
          artifactDigest: fact.digest,
          payload: { artifactId: fact.artifactId, kind: fact.kind, verificationStatus: fact.verificationStatus },
        };
      }
      case "approval.requested": {
        const attempt = this.requireMakerAttemptUnsafe(runId, fact.attemptId, fact.requestedByAgentId, fact.requestedBySessionId);
        this.assertAttemptDigest(attempt, fact.evidenceDigest);
        if (attempt.checker_status !== "approve" || attempt.status !== "success") {
          throw new HttpError(422, "APPROVAL_PRECONDITION", "Human approval requires an independent checker approval");
        }
        const stage = this.requireStageUnsafe(runId, fact.stageId);
        if (stage.role !== "human" || !["active", "waiting"].includes(stage.status)) {
          throw new HttpError(422, "INVALID_APPROVAL_STAGE", "Approval requests require an active or waiting human stage");
        }
        if (Date.parse(fact.expiresAt) <= Date.parse(acceptedAt)) {
          throw new HttpError(422, "INVALID_APPROVAL_EXPIRY", "Approval expiry must be in the future");
        }
        if (this.db.prepare("SELECT 1 FROM approvals WHERE id = ?").get(fact.approvalId)) {
          throw conflict("RECORD_ID_CONFLICT", `Approval '${fact.approvalId}' already exists`);
        }
        this.db.prepare(`INSERT INTO approvals(id, run_id, stage_id, status, requested_action, target, risk,
          evidence_digest, maker_summary, checker_verdict, checker_summary, requested_by, requested_at, expires_at)
          VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'approve', ?, ?, ?, ?)`)
          .run(fact.approvalId, runId, fact.stageId, safeText(fact.requestedAction), safeText(fact.target),
            fact.risk, fact.evidenceDigest, safeText(fact.makerSummary), attempt.checker_summary,
            fact.requestedByAgentId, acceptedAt, fact.expiresAt);
        return {
          recordType: "approval",
          recordId: fact.approvalId,
          stageId: fact.stageId,
          attemptId: fact.attemptId,
          actor: fact.requestedByAgentId,
          message: `Human approval requested: ${safeText(fact.requestedAction)}`,
          severity: "warning",
          artifactDigest: fact.evidenceDigest,
          payload: { approvalId: fact.approvalId, target: safeText(fact.target), expiresAt: fact.expiresAt },
        };
      }
    }
  }

  private mapRuntimeFactReceipt(row: Row, idempotent: boolean): RuntimeFactReceipt {
    return {
      id: row.id,
      runId: row.run_id,
      type: row.type,
      recordType: row.record_type,
      recordId: row.record_id,
      eventId: row.event_id,
      eventSequence: row.event_sequence,
      acceptedAt: row.accepted_at,
      idempotent,
    };
  }

  private requireStageUnsafe(runId: string, stageId: string): Row {
    const stage = this.db.prepare("SELECT * FROM stages WHERE id = ? AND run_id = ?").get(stageId, runId) as Row | undefined;
    if (!stage) throw new HttpError(422, "INVALID_REFERENCE", "Stage does not belong to this run");
    return stage;
  }

  private requireAttemptUnsafe(runId: string, attemptId: string): Row {
    const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ? AND run_id = ?").get(attemptId, runId) as Row | undefined;
    if (!attempt) throw new HttpError(422, "INVALID_REFERENCE", "Attempt does not belong to this run");
    return attempt;
  }

  private requireMakerAttemptUnsafe(
    runId: string,
    attemptId: string,
    makerAgentId: string,
    makerSessionId: string,
  ): Row {
    const attempt = this.requireAttemptUnsafe(runId, attemptId);
    if (attempt.maker_agent_id !== makerAgentId || attempt.maker_session_id !== makerSessionId) {
      throw new HttpError(422, "ATTEMPT_OWNERSHIP", "Only the registered maker session can mutate this attempt");
    }
    this.requireRuntimeAgentUnsafe(runId, makerAgentId, makerSessionId, ["maker"]);
    return attempt;
  }

  private requireRuntimeAgentUnsafe(runId: string, agentId: string, sessionId: string, roles: AgentRecord["role"][]): Row {
    const agent = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Row | undefined;
    if (!agent || agent.current_run_id !== runId || agent.session_id !== sessionId || !roles.includes(agent.role)) {
      throw new HttpError(422, "AGENT_IDENTITY", "Fact must come from a registered agent session assigned to this run");
    }
    if (!["starting", "running", "waiting"].includes(effectiveAgentStatus(agent))) {
      throw new HttpError(422, "AGENT_NOT_ACTIVE", "Agent session is stale or terminal; send a fresh heartbeat first");
    }
    return agent;
  }

  private assertAttemptDigest(attempt: Row, digest: string): void {
    if (!attempt.artifact_digest || attempt.artifact_digest !== digest) {
      throw new HttpError(422, "ARTIFACT_DIGEST_MISMATCH", "Fact is not bound to the attempt's current artifact digest");
    }
  }

  submitCheckerVerdict(runId: string, input: CheckerVerdictRequest, actor: Actor): ReviewRecord | AttemptRecord {
    const run = this.getRun(runId);
    if (run.sourceMode === "snapshot") throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
    if (isTerminalRun(run.status)) {
      throw conflict("TERMINAL_RUN", `Checker verdicts cannot mutate a run in '${run.status}'`);
    }
    if (run.breaker.status === "open" || run.status === "blocked") {
      throw conflict("BREAKER_OPEN", "Checker decisions are stopped until the circuit breaker is overridden and the run resumes");
    }
    const attemptRow = this.db.prepare("SELECT * FROM attempts WHERE id = ? AND run_id = ?").get(input.attemptId, runId) as Row | undefined;
    if (!attemptRow) throw notFound("Attempt", input.attemptId);
    const attempt = mapAttempt(attemptRow);
    if (attempt.status !== "running") {
      throw conflict("ATTEMPT_NOT_RUNNING", `Checker verdicts require a running attempt; '${attempt.id}' is '${attempt.status}'`);
    }
    try {
      assertIndependentChecker(attempt.makerAgentId, attempt.makerSessionId, input.checkerAgentId, input.checkerSessionId);
      assertMatchingDigest(attempt.artifactDigest, input.artifactDigest);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Checker invariant failed";
      this.insertAuditUnsafe(actor, "checker.verdict_rejected", "attempt", input.attemptId, message, {
        attemptedCheckerAgentId: input.checkerAgentId,
        attemptedCheckerSessionId: input.checkerSessionId,
        artifactDigest: input.artifactDigest,
      }, runId);
      throw new HttpError(422, "CHECKER_INVARIANT", message);
    }
    if (!["pending", "running"].includes(attempt.checkerStatus)) {
      throw conflict("VERDICT_IMMUTABLE", `Attempt already has checker verdict '${attempt.checkerStatus}'`);
    }
    const checker = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(input.checkerAgentId) as Row | undefined;
    if (!checker || checker.role !== "checker" || checker.session_id !== input.checkerSessionId
      || checker.current_run_id !== runId || ["stale", "error", "finished"].includes(effectiveAgentStatus(checker))) {
      throw new HttpError(422, "CHECKER_IDENTITY", "Checker identity must match a registered, active checker session assigned to this run");
    }
    const currentRequirements = (this.db.prepare(`SELECT * FROM requirements
      WHERE run_id = ? AND superseded_at IS NULL ORDER BY position`).all(runId) as Row[]).map(mapRequirement);
    const requirementIds = new Set(currentRequirements.map((requirement) => requirement.id));
    const seenResults = new Set<string>();
    const safeResults = input.requirementResults.map((result) => {
      if (!requirementIds.has(result.requirementId)) {
        throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Requirement ${result.requirementId} is not current for this run`);
      }
      if (seenResults.has(result.requirementId)) {
        throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Requirement ${result.requirementId} appears more than once`);
      }
      seenResults.add(result.requirementId);
      const evidenceIds = [...new Set(result.evidenceIds)];
      if (result.status === "pass" && evidenceIds.length === 0) {
        throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Passed requirement ${result.requirementId} must cite evidence`);
      }
      for (const evidenceId of evidenceIds) {
        const evidenceRow = this.db.prepare("SELECT * FROM evidence WHERE id = ? AND run_id = ?").get(evidenceId, runId) as Row | undefined;
        if (!evidenceRow || evidenceRow.requirement_id !== result.requirementId) {
          throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Evidence ${evidenceId} is not bound to requirement ${result.requirementId}`);
        }
        const evidence = mapEvidence(evidenceRow);
        if (result.status === "pass" && evidence.status !== "pass") {
          throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Evidence ${evidenceId} is not passing`);
        }
        if (evidence.expiresAt && Date.parse(evidence.expiresAt) <= Date.now()) {
          throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Evidence ${evidenceId} has expired`);
        }
        if (evidence.artifactDigest && evidence.artifactDigest !== input.artifactDigest) {
          throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", `Evidence ${evidenceId} does not match the reviewed artifact`);
        }
      }
      return { ...result, evidenceIds, note: safeText(result.note) };
    });
    if (input.verdict === "approve") {
      if (safeResults.length !== currentRequirements.length || safeResults.some((result) => result.status !== "pass")) {
        throw new HttpError(422, "INCOMPLETE_REQUIREMENT_REVIEW", "Approval requires a passing result with evidence for every current requirement");
      }
    }
    if (input.verdict === "error" && safeResults.length > 0) {
      throw new HttpError(422, "INVALID_REQUIREMENT_RESULT", "An errored checker cannot submit requirement results");
    }
    const timestamp = now();
    const safeSummary = redactText(input.summary).value;
    const reviewId = randomUUID();
    const event = transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE attempts SET checker_agent_id = ?, checker_session_id = ?, checker_status = ?,
        checker_summary = ?, status = CASE WHEN ? = 'approve' THEN 'success' WHEN ? = 'reject' THEN 'rejected'
          WHEN ? = 'escalate_human' THEN 'escalated' ELSE status END,
        finished_at = CASE WHEN ? IN ('approve','reject','escalate_human') THEN ? ELSE finished_at END,
        version = version + 1 WHERE id = ? AND status = 'running' AND checker_status IN ('pending','running')`)
        .run(input.checkerAgentId, input.checkerSessionId, input.verdict, safeSummary,
          input.verdict, input.verdict, input.verdict, input.verdict, timestamp, input.attemptId);
      if (result.changes !== 1) throw conflict("VERDICT_IMMUTABLE", "Another checker already decided this attempt");
      if (input.verdict !== "error") {
        this.db.prepare(`INSERT INTO reviews(id, run_id, attempt_id, checker_agent_id, checker_session_id,
          artifact_digest, verdict, summary, requirement_results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(reviewId, runId, input.attemptId, input.checkerAgentId, input.checkerSessionId,
            input.artifactDigest, input.verdict, safeSummary, JSON.stringify(safeResults), timestamp);
        const updateRequirement = this.db.prepare(`UPDATE requirements SET status = ?, evidence_ids_json = ?,
          checker_summary = ? WHERE id = ? AND run_id = ? AND superseded_at IS NULL`);
        for (const result of safeResults) updateRequirement.run(result.status, JSON.stringify(result.evidenceIds),
          result.note || safeSummary, result.requirementId, runId);
      }
      this.insertAuditUnsafe(actor, "checker.verdict", "attempt", input.attemptId, safeSummary, {
        checkerAgentId: input.checkerAgentId,
        checkerSessionId: input.checkerSessionId,
        artifactDigest: input.artifactDigest,
        verdict: input.verdict,
      });
      return this.insertEventUnsafe({
        runId,
        stageId: attempt.stageId,
        attemptId: attempt.id,
        type: "checker.verdict",
        severity: input.verdict === "approve" ? "info" : "warning",
        message: `Independent checker ${input.verdict}: ${safeSummary}`,
        payload: { checkerAgentId: input.checkerAgentId, verdict: input.verdict },
        provenance: "runtime",
        actor: input.checkerAgentId,
        artifactDigest: input.artifactDigest,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    if (input.verdict === "error") {
      return mapAttempt(this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(input.attemptId) as Row);
    }
    return mapReview(this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId) as Row);
  }

  decideApproval(id: string, input: ApprovalDecisionInput, actor: Actor): ApprovalRecord {
    const existingRow = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    if (!existingRow) throw notFound("Approval", id);
    const existing = mapApproval(existingRow);
    if (this.getRun(existing.runId).sourceMode === "snapshot") {
      throw conflict("SNAPSHOT_READ_ONLY", "Imported snapshot runs are read-only");
    }
    if (existing.status !== "pending") {
      throw conflict("APPROVAL_DECIDED", `Approval was already ${existing.status}`, { approval: existing });
    }
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      this.expireApproval(id);
      throw conflict("APPROVAL_EXPIRED", "Approval expired before this decision", { approval: this.getApproval(id) });
    }
    if (input.expectedVersion !== existing.version) {
      throw conflict("STALE_APPROVAL", "Approval changed before this decision", { approval: existing });
    }
    const timestamp = now();
    const safeReason = redactText(input.reason).value;
    const event = transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?,
        version = version + 1 WHERE id = ? AND status = 'pending' AND version = ?`)
        .run(input.decision, actor.id, timestamp, safeReason, id, input.expectedVersion);
      if (result.changes !== 1) throw conflict("STALE_APPROVAL", "Another operator decided this approval", { approval: this.getApproval(id) });
      this.insertAuditUnsafe(actor, `approval.${input.decision}`, "approval", id, safeReason, {
        requestedAction: existing.requestedAction,
        target: existing.target,
        evidenceDigest: existing.evidenceDigest,
      });
      return this.insertEventUnsafe({
        runId: existing.runId,
        stageId: existing.stageId,
        type: `approval.${input.decision}`,
        severity: input.decision === "approved" ? "info" : "warning",
        message: `${existing.requestedAction} ${input.decision} by ${actor.id}`,
        payload: { approvalId: id, reason: safeReason, target: existing.target },
        provenance: "human",
        actor: actor.id,
        artifactDigest: existing.evidenceDigest,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    return this.getApproval(id);
  }

  ingestEvent(input: EventInput, actor: Actor): EventRecord {
    const emitted = transaction(this.db, () => {
      const event = this.insertEventUnsafe(input);
      this.insertAuditUnsafe(actor, "event.ingest", "event", event.id, null, {
        sourceEventId: event.id,
        eventType: event.type,
        provenance: event.provenance,
      }, event.runId);
      return [event, ...this.applyTelemetryUnsafe(event)];
    });
    for (const event of emitted) this.eventHub.publish(event);
    return emitted[0];
  }

  private applyTelemetryUnsafe(event: EventRecord): EventRecord[] {
    if (event.type === "budget.updated") return this.applyBudgetTelemetryUnsafe(event);
    if (event.type === "attempt.failed") return this.applyFailureTelemetryUnsafe(event);
    if (event.type === "attempt.succeeded") {
      this.db.prepare(`UPDATE runs SET same_error_count = 0, consecutive_failures = 0, error_signature = NULL,
        breaker_status = CASE WHEN breaker_status = 'warning' AND breaker_trigger LIKE 'Failure warning:%' THEN 'closed' ELSE breaker_status END,
        breaker_trigger = CASE WHEN breaker_status = 'warning' AND breaker_trigger LIKE 'Failure warning:%' THEN NULL ELSE breaker_trigger END,
        updated_at = ?, version = version + 1 WHERE id = ?`).run(now(), event.runId);
    }
    return [];
  }

  private applyBudgetTelemetryUnsafe(event: EventRecord): EventRecord[] {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(event.runId) as Row;
    if (isTerminalRun(row.status)) throw conflict("TERMINAL_RUN", "Budget telemetry cannot mutate a terminal run");
    const requested = {
      tokens: readUsageNumber(event.payload, "tokensUsed", row.tokens_used),
      cost: readUsageNumber(event.payload, "costUsedUsd", row.cost_used_usd),
      iterations: readUsageNumber(event.payload, "iterationsUsed", row.iterations_used),
    };
    if (requested.tokens < row.tokens_used || requested.cost < row.cost_used_usd || requested.iterations < row.iterations_used) {
      throw conflict("USAGE_REGRESSION", "Cumulative budget usage cannot decrease");
    }
    const tokenPercent = row.token_limit > 0 ? requested.tokens / row.token_limit * 100 : 100;
    const costPercent = row.cost_limit_usd > 0 ? requested.cost / row.cost_limit_usd * 100 : requested.cost > 0 ? 100 : 0;
    const iterationPercent = row.iteration_limit > 0 ? requested.iterations / row.iteration_limit * 100 : 100;
    const maxPercent = Math.max(tokenPercent, costPercent, iterationPercent);
    const exhausted = requested.tokens >= row.token_limit
      || (row.cost_limit_usd > 0 && requested.cost >= row.cost_limit_usd)
      || requested.iterations >= row.iteration_limit;
    const timestamp = now();

    if (exhausted) {
      try {
        assertRunTransition(row.status, "capped");
      } catch {
        throw conflict("INVALID_TELEMETRY_STATE", `Run in '${row.status}' cannot be capped by budget telemetry`);
      }
      const trigger = `Budget exhausted: ${Math.round(maxPercent)}% of bounded allowance`;
      this.db.prepare(`UPDATE runs SET tokens_used = ?, cost_used_usd = ?, iterations_used = ?, status = 'capped',
        breaker_status = 'open', breaker_trigger = ?, breaker_opened_at = ?, finished_at = ?, updated_at = ?, version = version + 1
        WHERE id = ?`).run(requested.tokens, requested.cost, requested.iterations, trigger, timestamp, timestamp, timestamp, event.runId);
      this.insertAuditUnsafe({ id: "controller", name: "Controller", role: "admin" }, "breaker.open", "run", event.runId,
        trigger, { sourceEventId: event.id, tokensUsed: requested.tokens, costUsedUsd: requested.cost, iterationsUsed: requested.iterations });
      return [this.insertEventUnsafe({
        runId: event.runId,
        stageId: event.stageId,
        attemptId: event.attemptId,
        type: "budget.exhausted",
        severity: "critical",
        message: trigger,
        payload: { ...requested, tokenPercent, costPercent, iterationPercent, sourceEventId: event.id },
        provenance: "derived",
        actor: "controller",
        correlationId: event.correlationId,
        occurredAt: timestamp,
      })];
    }

    const warning = maxPercent >= row.warning_percent;
    this.db.prepare(`UPDATE runs SET tokens_used = ?, cost_used_usd = ?, iterations_used = ?,
      breaker_status = CASE WHEN ? AND breaker_status = 'closed' THEN 'warning' ELSE breaker_status END,
      breaker_trigger = CASE WHEN ? AND breaker_status = 'closed' THEN ? ELSE breaker_trigger END,
      updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(requested.tokens, requested.cost, requested.iterations, warning ? 1 : 0, warning ? 1 : 0,
        warning ? `Budget warning: ${Math.round(maxPercent)}% consumed` : null, timestamp, event.runId);
    if (!warning || row.breaker_status !== "closed") return [];
    return [this.insertEventUnsafe({
      runId: event.runId,
      stageId: event.stageId,
      attemptId: event.attemptId,
      type: "budget.warning",
      severity: "warning",
      message: `Budget warning threshold reached (${Math.round(maxPercent)}%)`,
      payload: { ...requested, tokenPercent, costPercent, iterationPercent, sourceEventId: event.id },
      provenance: "derived",
      actor: "controller",
      correlationId: event.correlationId,
      occurredAt: timestamp,
    })];
  }

  private applyFailureTelemetryUnsafe(event: EventRecord): EventRecord[] {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(event.runId) as Row;
    if (isTerminalRun(row.status)) throw conflict("TERMINAL_RUN", "Failure telemetry cannot mutate a terminal run");
    const signatureValue = event.payload.errorSignature;
    const signature = typeof signatureValue === "string" && signatureValue.trim()
      ? safeText(signatureValue.trim()).slice(0, 500)
      : "UNCLASSIFIED_FAILURE";
    const sameErrorCount = row.error_signature === signature ? row.same_error_count + 1 : 1;
    const consecutiveFailures = row.consecutive_failures + 1;
    const shouldOpen = sameErrorCount >= row.same_error_limit || consecutiveFailures >= row.consecutive_failure_limit;
    const timestamp = now();
    if (row.breaker_status === "open") {
      this.db.prepare(`UPDATE runs SET same_error_count = ?, consecutive_failures = ?, error_signature = ?,
        updated_at = ?, version = version + 1 WHERE id = ? AND breaker_status = 'open'`)
        .run(sameErrorCount, consecutiveFailures, signature, timestamp, event.runId);
      return [];
    }
    if (!shouldOpen) {
      const nearingThreshold = sameErrorCount === row.same_error_limit - 1
        || consecutiveFailures === row.consecutive_failure_limit - 1;
      this.db.prepare(`UPDATE runs SET same_error_count = ?, consecutive_failures = ?, error_signature = ?,
        breaker_status = CASE WHEN ? AND breaker_status = 'closed' THEN 'warning' ELSE breaker_status END,
        breaker_trigger = CASE WHEN ? AND breaker_status = 'closed' THEN ? ELSE breaker_trigger END,
        updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(sameErrorCount, consecutiveFailures, signature, nearingThreshold ? 1 : 0, nearingThreshold ? 1 : 0,
          nearingThreshold ? `Failure warning: ${sameErrorCount}/${row.same_error_limit} repeated errors` : null,
          timestamp, event.runId);
      return [];
    }
    try {
      assertRunTransition(row.status, "blocked");
    } catch {
      throw conflict("INVALID_TELEMETRY_STATE", `Run in '${row.status}' cannot be blocked by its circuit breaker`);
    }
    const trigger = sameErrorCount >= row.same_error_limit
      ? `Same error repeated ${sameErrorCount} times`
      : `${consecutiveFailures} consecutive attempts failed`;
    this.db.prepare(`UPDATE runs SET same_error_count = ?, consecutive_failures = ?, error_signature = ?,
      breaker_status = 'open', breaker_trigger = ?, breaker_opened_at = ?, status = 'blocked',
      blocked_owner = 'operator', unblock_condition = 'Review failure evidence and explicitly override the breaker',
      updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(sameErrorCount, consecutiveFailures, signature, trigger, timestamp, timestamp, event.runId);
    this.insertAuditUnsafe({ id: "controller", name: "Controller", role: "admin" }, "breaker.open", "run", event.runId,
      trigger, { sourceEventId: event.id, errorSignature: signature, sameErrorCount, consecutiveFailures });
    return [this.insertEventUnsafe({
      runId: event.runId,
      stageId: event.stageId,
      attemptId: event.attemptId,
      type: "breaker.opened",
      severity: "critical",
      message: `${trigger}; automatic progress stopped`,
      payload: { errorSignature: signature, sameErrorCount, consecutiveFailures, sourceEventId: event.id },
      provenance: "derived",
      actor: "controller",
      correlationId: event.correlationId,
      occurredAt: timestamp,
    })];
  }

  private insertEventUnsafe(input: Omit<EventInput, "id" | "sequence"> & { id?: string; sequence?: number }): EventRecord {
    const runRow = this.db.prepare("SELECT id, last_sequence FROM runs WHERE id = ?").get(input.runId) as Row | undefined;
    if (!runRow) throw notFound("Run", input.runId);
    if (input.stageId) {
      const stage = this.db.prepare("SELECT 1 FROM stages WHERE id = ? AND run_id = ?").get(input.stageId, input.runId);
      if (!stage) throw new HttpError(422, "INVALID_REFERENCE", "stageId does not belong to this run");
    }
    if (input.attemptId) {
      const attempt = this.db.prepare("SELECT 1 FROM attempts WHERE id = ? AND run_id = ?").get(input.attemptId, input.runId);
      if (!attempt) throw new HttpError(422, "INVALID_REFERENCE", "attemptId does not belong to this run");
    }
    const sequence = input.sequence ?? Number(runRow.last_sequence) + 1;
    if (sequence <= Number(runRow.last_sequence)) {
      throw conflict("SEQUENCE_REGRESSION", `Sequence ${sequence} is not greater than ${runRow.last_sequence}`);
    }
    const id = input.id ?? randomUUID();
    if (this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(id)) throw conflict("DUPLICATE_EVENT", `Event '${id}' already exists`);
    const message = redactText(input.message);
    const payload = redactValue(input.payload ?? {});
    const correlationId = input.correlationId ? redactText(input.correlationId) : { value: null, redacted: false };
    // Usage counts are telemetry, not credentials. Preserve only numeric values for
    // this explicit key; string values still pass through the secret redactor.
    if (typeof input.payload?.tokensUsed === "number") payload.value.tokensUsed = input.payload.tokensUsed;
    const receivedAt = now();
    try {
      this.db.prepare(`INSERT INTO events(id, run_id, sequence, stage_id, attempt_id, type, severity, message,
        payload_json, provenance, actor, correlation_id, artifact_digest, redacted, occurred_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.runId, sequence, input.stageId ?? null, input.attemptId ?? null, input.type,
          input.severity ?? "info", message.value, JSON.stringify(payload.value), input.provenance, input.actor,
          correlationId.value, input.artifactDigest ?? null,
          message.redacted || payload.redacted || correlationId.redacted ? 1 : 0,
          input.occurredAt, receivedAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw conflict("DUPLICATE_EVENT", "Event ID or run sequence already exists");
      }
      throw error;
    }
    this.db.prepare(`UPDATE runs SET last_sequence = ?, last_event_at = ?, updated_at = ?, version = version + 1
      WHERE id = ?`).run(sequence, receivedAt, receivedAt, input.runId);
    return mapEvent(this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row);
  }

  private retryRun(source: RunRecord, actor: Actor, reason?: string): RunRecord {
    if (!["failed", "timed_out", "cancelled", "capped"].includes(source.status)) {
      throw conflict("RUN_NOT_RETRYABLE", `Run in '${source.status}' cannot be retried; evidence remains immutable`);
    }
    const newId = randomUUID();
    const timestamp = now();
    const event = transaction(this.db, () => {
      this.db.prepare(`INSERT INTO runs(id, loop_id, project_name, repository_path, runtime, model, goal, status,
        automation_level, risk, updated_at, source_mode, token_limit, cost_limit_usd, iteration_limit, warning_percent)
        SELECT ?, loop_id, project_name, repository_path, runtime, model, goal, 'queued', automation_level, risk, ?, source_mode,
          token_limit, cost_limit_usd, iteration_limit, warning_percent FROM runs WHERE id = ?`)
        .run(newId, timestamp, source.id);
      const stages = this.db.prepare("SELECT key, name, position, role FROM stages WHERE run_id = ? ORDER BY position").all(source.id) as Row[];
      const insert = this.db.prepare(`INSERT INTO stages(id, run_id, key, name, position, role, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`);
      for (const stage of stages) insert.run(randomUUID(), newId, stage.key, stage.name, stage.position, stage.role);
      const requirements = this.db.prepare(`SELECT position, title, description, acceptance_criteria, content_hash
        FROM requirements WHERE run_id = ? AND superseded_at IS NULL ORDER BY position`).all(source.id) as Row[];
      const insertRequirement = this.db.prepare(`INSERT INTO requirements(id, run_id, revision, position, title,
        description, acceptance_criteria, status, content_hash, evidence_ids_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'pending', ?, '[]', ?)`);
      for (const requirement of requirements) insertRequirement.run(randomUUID(), newId, requirement.position,
        requirement.title, requirement.description, requirement.acceptance_criteria, requirement.content_hash, timestamp);
      this.insertAuditUnsafe(actor, "run.retry", "run", source.id, reason ?? null, { retryRunId: newId });
      this.insertAuditUnsafe(actor, "run.created_from_retry", "run", newId, reason ?? null, { sourceRunId: source.id });
      return this.insertEventUnsafe({
        runId: newId,
        type: "run.retried",
        severity: "info",
        message: `Retry created from immutable run ${source.id}`,
        payload: { sourceRunId: source.id, reason },
        provenance: "human",
        actor: actor.id,
        occurredAt: timestamp,
      });
    });
    this.eventHub.publish(event);
    return this.getRun(newId);
  }

  private getApproval(id: string): ApprovalRecord {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("Approval", id);
    return mapApproval(row);
  }

  private expireApproval(id: string): void {
    transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM approvals WHERE id = ? AND status = 'pending'").get(id) as Row | undefined;
      if (!row) return;
      this.db.prepare("UPDATE approvals SET status = 'expired', version = version + 1 WHERE id = ? AND status = 'pending'").run(id);
      this.insertAuditUnsafe({ id: "system", name: "System", role: "admin" }, "approval.expired", "approval", id, "Expiry time elapsed", {});
    });
  }

  private expireApprovals(): void {
    const expired = this.db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?").all(now()) as Row[];
    for (const row of expired) this.expireApproval(row.id);
  }

  private insertAuditUnsafe(
    actor: Actor,
    action: string,
    targetType: string,
    targetId: string,
    reason: string | null,
    metadata: Record<string, unknown>,
    runId?: string | null,
  ): AuditRecord {
    const id = randomUUID();
    const createdAt = now();
    const safeMetadata = redactValue(metadata);
    let resolvedRunId = runId ?? null;
    if (runId === undefined && targetType === "run") resolvedRunId = targetId;
    if (runId === undefined && ["stage", "attempt", "approval"].includes(targetType)) {
      const table = targetType === "stage" ? "stages" : targetType === "attempt" ? "attempts" : "approvals";
      resolvedRunId = (this.db.prepare(`SELECT run_id FROM ${table} WHERE id = ?`).get(targetId) as Row | undefined)?.run_id ?? null;
    }
    const safeReason = reason ? redactText(reason).value : null;
    this.db.prepare(`INSERT INTO audit_log(id, run_id, actor, actor_role, action, target_type, target_id, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, resolvedRunId, actor.id, actor.role, action, targetType, targetId, safeReason,
        JSON.stringify(safeMetadata.value), createdAt);
    return mapAudit(this.db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id) as Row);
  }
}

function readUsageNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
  const value = payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(422, "INVALID_USAGE", `${key} must be a finite non-negative number`);
  }
  return value;
}
