export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "blocked",
  "capped",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;

export const STAGE_STATUSES = [
  "pending",
  "active",
  "waiting",
  "passed",
  "rejected",
  "failed",
  "skipped",
  "blocked",
] as const;

export const ATTEMPT_STATUSES = [
  "running",
  "success",
  "failure",
  "noop",
  "rejected",
  "escalated",
  "cancelled",
] as const;

export const CHECKER_STATUSES = [
  "pending",
  "running",
  "approve",
  "reject",
  "escalate_human",
  "error",
] as const;

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "revoked",
] as const;

export const BREAKER_STATUSES = ["closed", "warning", "open", "overridden"] as const;
export const AGENT_STATUSES = ["starting", "running", "waiting", "finished", "error", "stale"] as const;
export const WORKTREE_STATUSES = ["active", "rejected", "escalated", "merged", "stale"] as const;
export const PROVENANCE_TYPES = ["runtime", "agent_reported", "derived", "snapshot", "human"] as const;
export const ROLES = ["viewer", "operator", "admin"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type StageStatus = (typeof STAGE_STATUSES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type CheckerStatus = (typeof CHECKER_STATUSES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type BreakerStatus = (typeof BREAKER_STATUSES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];
export type Provenance = (typeof PROVENANCE_TYPES)[number];
export type Role = (typeof ROLES)[number];

export interface BudgetSnapshot {
  tokenLimit: number;
  tokensUsed: number;
  costLimitUsd: number;
  costUsedUsd: number;
  iterationLimit: number;
  iterationsUsed: number;
  warningPercent: number;
}

export interface BreakerSnapshot {
  status: BreakerStatus;
  sameErrorCount: number;
  sameErrorLimit: number;
  consecutiveFailures: number;
  consecutiveFailureLimit: number;
  trigger: string | null;
  errorSignature: string | null;
  openedAt: string | null;
  overriddenBy: string | null;
}

export interface LoopDefinition {
  id: string;
  name: string;
  description: string;
  automationLevel: "L1" | "L2" | "L3";
  owner: string;
  schedule: string | null;
  risk: "low" | "medium" | "high" | "critical";
  readinessScore: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  policyVersion: string;
}

export interface RunRecord {
  id: string;
  loopId: string;
  loopName: string;
  projectName: string;
  repositoryPath: string | null;
  runtime: string;
  model: string;
  goal: string;
  status: RunStatus;
  automationLevel: "L1" | "L2" | "L3";
  risk: "low" | "medium" | "high" | "critical";
  currentStageId: string | null;
  currentStageName: string | null;
  waitingReason: string | null;
  blockedOwner: string | null;
  unblockCondition: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  lastEventAt: string | null;
  lastSequence: number;
  sourceMode: "managed" | "snapshot";
  freshness: "live" | "delayed" | "stale" | "unknown";
  requirementProgress: {
    total: number;
    passed: number;
    failed: number;
    missing: number;
  };
  budget: BudgetSnapshot;
  breaker: BreakerSnapshot;
}

export interface StageRecord {
  id: string;
  runId: string;
  key: string;
  name: string;
  position: number;
  role: "system" | "triage" | "maker" | "checker" | "human";
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  waitingReason: string | null;
  skipReason: string | null;
}

export interface AttemptRecord {
  id: string;
  runId: string;
  stageId: string;
  number: number;
  status: AttemptStatus;
  makerAgentId: string;
  makerSessionId: string;
  checkerAgentId: string | null;
  checkerSessionId: string | null;
  checkerStatus: CheckerStatus;
  checkerSummary: string | null;
  artifactDigest: string | null;
  worktreePath: string | null;
  branch: string | null;
  previousAttemptId: string | null;
  feedbackReviewId: string | null;
  feedbackSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface VerificationRecord {
  id: string;
  attemptId: string;
  name: string;
  command: string;
  status: "running" | "passed" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number | null;
  evidenceDigest: string | null;
  outputPreview: string | null;
}

export interface RequirementRecord {
  id: string;
  runId: string;
  revision: number;
  position: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: "pending" | "pass" | "fail" | "missing";
  contentHash: string;
  evidenceIds: string[];
  checkerSummary: string | null;
  createdAt: string;
  supersededAt: string | null;
}

export interface EvidenceRecord {
  id: string;
  runId: string;
  requirementId: string | null;
  attemptId: string | null;
  kind: "command" | "test" | "diff" | "artifact" | "screenshot" | "review" | "other";
  status: "running" | "pass" | "fail" | "missing";
  summary: string;
  command: string | null;
  exitCode: number | null;
  rawLogRef: string | null;
  artifactDigest: string | null;
  producer: string;
  provenance: Provenance;
  createdAt: string;
  expiresAt: string | null;
}

export interface ReviewRecord {
  id: string;
  runId: string;
  attemptId: string;
  checkerAgentId: string;
  checkerSessionId: string;
  artifactDigest: string;
  verdict: "approve" | "reject" | "escalate_human";
  summary: string;
  requirementResults: Array<{
    requirementId: string;
    status: "pass" | "fail" | "missing";
    evidenceIds: string[];
    note: string;
  }>;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stageId: string;
  status: ApprovalStatus;
  requestedAction: string;
  target: string;
  risk: "low" | "medium" | "high" | "critical";
  evidenceDigest: string;
  makerSummary: string;
  checkerVerdict: CheckerStatus;
  checkerSummary: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  role: "triage" | "maker" | "checker" | "system";
  runtime: string;
  model: string;
  status: AgentStatus;
  currentRunId: string | null;
  currentAction: string | null;
  lastHeartbeatAt: string | null;
  sessionId: string | null;
  worktreePath: string | null;
}

export interface WorktreeRecord {
  id: string;
  runId: string;
  attemptId: string | null;
  path: string;
  branch: string;
  commit: string | null;
  dirty: boolean;
  status: WorktreeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  attemptId: string | null;
  name: string;
  kind: "diff" | "report" | "log" | "dataset" | "workbook" | "other";
  uri: string;
  digest: string;
  sizeBytes: number;
  createdAt: string;
  producer: string;
  verificationStatus: "unverified" | "verified" | "invalid" | "missing";
  sensitivity: "public" | "internal" | "restricted";
}

export interface EventRecord {
  id: string;
  runId: string;
  sequence: number;
  stageId: string | null;
  attemptId: string | null;
  type: string;
  severity: "debug" | "info" | "warning" | "error" | "critical";
  message: string;
  payload: Record<string, unknown>;
  provenance: Provenance;
  actor: string;
  correlationId: string | null;
  artifactDigest: string | null;
  redacted: boolean;
  occurredAt: string;
  receivedAt: string;
}

export interface RuntimeFactReceipt {
  id: string;
  runId: string;
  type: string;
  recordType: string;
  recordId: string;
  eventId: string;
  eventSequence: number;
  acceptedAt: string;
  idempotent: boolean;
}

export interface AuditRecord {
  id: string;
  runId: string | null;
  actor: string;
  actorRole: Role;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PolicyRecord {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  scope: string;
  description: string;
  rules: Array<{
    key: string;
    effect: "allow" | "deny" | "require_approval" | "warn";
    value: unknown;
  }>;
  updatedAt: string;
  updatedBy: string;
}

export interface AttentionItem {
  id: string;
  kind: "approval" | "breaker" | "stale_agent" | "budget" | "policy";
  severity: "warning" | "critical";
  title: string;
  detail: string;
  runId: string | null;
  createdAt: string;
}

export interface OverviewResponse {
  generatedAt: string;
  connection: {
    mode: "managed" | "snapshot";
    status: "connected" | "degraded" | "disconnected";
    lastEventAt: string | null;
    globalPause: boolean;
  };
  counts: {
    activeRuns: number;
    waitingRuns: number;
    pendingApprovals: number;
    openBreakers: number;
    staleAgents: number;
  };
  metrics: {
    totalRuns: number;
    terminalRuns: number;
    succeededRuns: number;
    unsuccessfulRuns: number;
    successRatePct: number | null;
  };
  attention: AttentionItem[];
  activeRuns: RunRecord[];
  loops: LoopDefinition[];
  recentEvents: EventRecord[];
}

export interface RunDetailResponse {
  run: RunRecord;
  stages: StageRecord[];
  attempts: AttemptRecord[];
  requirements: RequirementRecord[];
  evidence: EvidenceRecord[];
  reviews: ReviewRecord[];
  verifications: VerificationRecord[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
  worktrees: WorktreeRecord[];
  events: EventRecord[];
  agents: AgentRecord[];
  audit: AuditRecord[];
}
