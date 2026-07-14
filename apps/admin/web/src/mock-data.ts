import type { AgentRecord, ApprovalRecord, ArtifactRecord, AuditRecord, EventRecord, LoopDefinition, OverviewResponse, RunDetailResponse, RunRecord, StageRecord, VerificationRecord } from "./types";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

export const loops: LoopDefinition[] = [
  { id: "loop-pr", name: "Pull request delivery", description: "Triage a request, implement in an isolated worktree, verify, review, and prepare a pull request.", automationLevel: "L2", owner: "platform", schedule: null, risk: "medium", readinessScore: 92, enabled: true, lastRunAt: ago(8), nextRunAt: null, policyVersion: "delivery-v4" },
  { id: "loop-ci", name: "CI failure sweeper", description: "Diagnose actionable failures and apply bounded fixes with independent verification.", automationLevel: "L2", owner: "developer-experience", schedule: "*/30 * * * *", risk: "medium", readinessScore: 86, enabled: true, lastRunAt: ago(24), nextRunAt: later(6), policyVersion: "ci-v3" },
  { id: "loop-deps", name: "Dependency upkeep", description: "Open low-risk dependency updates after tests, license checks, and approval.", automationLevel: "L1", owner: "security", schedule: "0 9 * * 1", risk: "high", readinessScore: 74, enabled: false, lastRunAt: ago(1440), nextRunAt: null, policyVersion: "supply-chain-v2" },
  { id: "loop-docs", name: "Release notes", description: "Compile verified merged changes into an evidence-linked release draft.", automationLevel: "L3", owner: "release", schedule: "0 16 * * 5", risk: "low", readinessScore: 96, enabled: true, lastRunAt: ago(320), nextRunAt: later(280), policyVersion: "docs-v2" },
];

const budget = { tokenLimit: 120_000, tokensUsed: 58_420, costLimitUsd: 25, costUsedUsd: 8.74, iterationLimit: 8, iterationsUsed: 3, warningPercent: 80 };
const breaker = { status: "warning" as const, sameErrorCount: 1, sameErrorLimit: 3, consecutiveFailures: 1, consecutiveFailureLimit: 3, trigger: null, errorSignature: "test:auth-session-timeout", openedAt: null, overriddenBy: null };

export const runs: RunRecord[] = [
  { id: "run-2048", loopId: "loop-pr", loopName: "Pull request delivery", projectName: "Atlas Console", repositoryPath: "/Users/local/Code/atlas-console", runtime: "Codex CLI", model: "gpt-5.2-codex", goal: "Add resumable uploads with clear recovery status and operator-safe retry controls", status: "running", automationLevel: "L2", risk: "medium", currentStageId: "stage-maker", currentStageName: "Maker implementation", waitingReason: null, blockedOwner: null, unblockCondition: null, startedAt: ago(42), updatedAt: ago(1), finishedAt: null, lastEventAt: ago(1), lastSequence: 38, sourceMode: "managed", freshness: "live", requirementProgress: { total: 3, passed: 1, failed: 1, missing: 1 }, budget, breaker },
  { id: "run-2047", loopId: "loop-ci", loopName: "CI failure sweeper", projectName: "Identity Service", repositoryPath: "/Users/local/Code/identity", runtime: "Claude Code", model: "claude-opus-4.6", goal: "Restore deterministic authentication integration tests on main", status: "waiting", automationLevel: "L2", risk: "medium", currentStageId: "stage-human", currentStageName: "Human gate", waitingReason: "Approval required before modifying the shared test fixture", blockedOwner: "release-operator", unblockCondition: "Approve scoped fixture update", startedAt: ago(96), updatedAt: ago(12), finishedAt: null, lastEventAt: ago(12), lastSequence: 27, sourceMode: "managed", freshness: "live", requirementProgress: { total: 2, passed: 1, failed: 0, missing: 1 }, budget: { ...budget, tokensUsed: 76_230, iterationsUsed: 5 }, breaker: { ...breaker, status: "closed", sameErrorCount: 0, consecutiveFailures: 0, errorSignature: null } },
  { id: "run-2046", loopId: "loop-docs", loopName: "Release notes", projectName: "Loop Engineering", repositoryPath: "/Users/local/Code/loop-engineering", runtime: "Codex CLI", model: "gpt-5.2", goal: "Draft release notes for version 1.8 from merged evidence", status: "succeeded", automationLevel: "L3", risk: "low", currentStageId: null, currentStageName: null, waitingReason: null, blockedOwner: null, unblockCondition: null, startedAt: ago(205), updatedAt: ago(167), finishedAt: ago(167), lastEventAt: ago(167), lastSequence: 61, sourceMode: "managed", freshness: "live", requirementProgress: { total: 3, passed: 3, failed: 0, missing: 0 }, budget: { ...budget, tokensUsed: 32_100, costUsedUsd: 4.2, iterationsUsed: 2 }, breaker: { ...breaker, status: "closed", sameErrorCount: 0, consecutiveFailures: 0, errorSignature: null } },
  { id: "run-2045", loopId: "loop-deps", loopName: "Dependency upkeep", projectName: "Schema Toolkit", repositoryPath: "/Users/local/Code/schema-toolkit", runtime: "OpenHands", model: "claude-sonnet-4.6", goal: "Evaluate and update the JSON schema toolchain", status: "blocked", automationLevel: "L1", risk: "high", currentStageId: "stage-verify", currentStageName: "Deterministic verification", waitingReason: null, blockedOwner: "security", unblockCondition: "Resolve critical transitive advisory or accept exception", startedAt: ago(380), updatedAt: ago(215), finishedAt: null, lastEventAt: ago(215), lastSequence: 44, sourceMode: "snapshot", freshness: "stale", requirementProgress: { total: 3, passed: 1, failed: 2, missing: 0 }, budget: { ...budget, tokensUsed: 112_500, iterationsUsed: 7 }, breaker: { ...breaker, status: "open", sameErrorCount: 3, consecutiveFailures: 3, trigger: "Repeated license verification failure", openedAt: ago(215) } },
  { id: "run-2044", loopId: "loop-ci", loopName: "CI failure sweeper", projectName: "Desktop Runtime", repositoryPath: "C:\\Code\\desktop-runtime", runtime: "Codex CLI", model: "gpt-5.2-codex", goal: "Repair Windows path normalization test failures", status: "failed", automationLevel: "L2", risk: "medium", currentStageId: null, currentStageName: null, waitingReason: null, blockedOwner: null, unblockCondition: null, startedAt: ago(540), updatedAt: ago(480), finishedAt: ago(480), lastEventAt: ago(480), lastSequence: 33, sourceMode: "managed", freshness: "delayed", requirementProgress: { total: 2, passed: 1, failed: 1, missing: 0 }, budget: { ...budget, tokensUsed: 87_900, iterationsUsed: 8 }, breaker: { ...breaker, status: "open", sameErrorCount: 2, consecutiveFailures: 3, trigger: "Iteration budget exhausted", openedAt: ago(480) } },
];

export const stages: StageRecord[] = [
  { id: "stage-trigger", runId: "run-2048", key: "trigger", name: "Trigger & intake", position: 1, role: "system", status: "passed", startedAt: ago(42), finishedAt: ago(41), durationMs: 54_000, waitingReason: null, skipReason: null },
  { id: "stage-triage", runId: "run-2048", key: "triage", name: "Triage & plan", position: 2, role: "triage", status: "passed", startedAt: ago(41), finishedAt: ago(36), durationMs: 301_000, waitingReason: null, skipReason: null },
  { id: "stage-context", runId: "run-2048", key: "context", name: "Load policy & state", position: 3, role: "system", status: "passed", startedAt: ago(36), finishedAt: ago(34), durationMs: 102_000, waitingReason: null, skipReason: null },
  { id: "stage-maker", runId: "run-2048", key: "maker", name: "Maker implementation", position: 4, role: "maker", status: "active", startedAt: ago(34), finishedAt: null, durationMs: null, waitingReason: null, skipReason: null },
  { id: "stage-verify", runId: "run-2048", key: "verify", name: "Deterministic verify", position: 5, role: "system", status: "pending", startedAt: null, finishedAt: null, durationMs: null, waitingReason: null, skipReason: null },
  { id: "stage-checker", runId: "run-2048", key: "checker", name: "Independent checker", position: 6, role: "checker", status: "pending", startedAt: null, finishedAt: null, durationMs: null, waitingReason: null, skipReason: null },
  { id: "stage-human", runId: "run-2048", key: "human", name: "Human gate", position: 7, role: "human", status: "pending", startedAt: null, finishedAt: null, durationMs: null, waitingReason: null, skipReason: null },
  { id: "stage-final", runId: "run-2048", key: "final", name: "Apply & persist", position: 8, role: "system", status: "pending", startedAt: null, finishedAt: null, durationMs: null, waitingReason: null, skipReason: null },
];

export const agents: AgentRecord[] = [
  { id: "agent-maker-1", name: "Maker 01", role: "maker", runtime: "Codex CLI", model: "gpt-5.2-codex", status: "running", currentRunId: "run-2048", currentAction: "Editing upload-resume.ts and preserving existing retry semantics", lastHeartbeatAt: ago(0.2), sessionId: "ses_91d0a", worktreePath: "/worktrees/run-2048-attempt-3" },
  { id: "agent-checker-1", name: "Checker 01", role: "checker", runtime: "Claude Code", model: "claude-opus-4.6", status: "waiting", currentRunId: "run-2048", currentAction: "Waiting for immutable artifact digest from maker", lastHeartbeatAt: ago(0.5), sessionId: "ses_663cf", worktreePath: "/worktrees/run-2048-checker" },
  { id: "agent-triage-1", name: "Triage", role: "triage", runtime: "Codex CLI", model: "gpt-5.2", status: "finished", currentRunId: null, currentAction: null, lastHeartbeatAt: ago(38), sessionId: null, worktreePath: null },
  { id: "agent-maker-2", name: "Maker 02", role: "maker", runtime: "OpenHands", model: "claude-sonnet-4.6", status: "stale", currentRunId: "run-2045", currentAction: "License manifest scan", lastHeartbeatAt: ago(215), sessionId: "ses_d301e", worktreePath: "/worktrees/run-2045-attempt-7" },
];

export const attempts = [
  { id: "attempt-1", runId: "run-2048", stageId: "stage-maker", number: 1, status: "failure" as const, makerAgentId: "agent-maker-1", makerSessionId: "ses_42a1", checkerAgentId: "agent-checker-1", checkerSessionId: "ses_371a", checkerStatus: "reject" as const, checkerSummary: "Retry state was stored in component memory and did not survive navigation.", previousAttemptId: null, feedbackReviewId: null, feedbackSummary: null, artifactDigest: "sha256:61f3a1c9e9", worktreePath: "/worktrees/run-2048-attempt-1", branch: "loop/run-2048-a1", startedAt: ago(34), finishedAt: ago(24) },
  { id: "attempt-2", runId: "run-2048", stageId: "stage-maker", number: 2, status: "failure" as const, makerAgentId: "agent-maker-1", makerSessionId: "ses_8bb3", checkerAgentId: "agent-checker-1", checkerSessionId: "ses_a1ca", checkerStatus: "reject" as const, checkerSummary: "Persistence is correct, but the stale upload token is reused after a checksum mismatch.", previousAttemptId: "attempt-1", feedbackReviewId: "review-1", feedbackSummary: "Persist retry state outside component memory so navigation cannot erase progress.", artifactDigest: "sha256:72b4e3271f", worktreePath: "/worktrees/run-2048-attempt-2", branch: "loop/run-2048-a2", startedAt: ago(23), finishedAt: ago(12) },
  { id: "attempt-3", runId: "run-2048", stageId: "stage-maker", number: 3, status: "running" as const, makerAgentId: "agent-maker-1", makerSessionId: "ses_91d0a", checkerAgentId: null, checkerSessionId: null, checkerStatus: "pending" as const, checkerSummary: null, previousAttemptId: "attempt-2", feedbackReviewId: "review-2", feedbackSummary: "Rotate the stale upload token after checksum mismatch before resuming.", artifactDigest: null, worktreePath: "/worktrees/run-2048-attempt-3", branch: "loop/run-2048-a3", startedAt: ago(11), finishedAt: null },
];

export const verifications: VerificationRecord[] = [
  { id: "verify-1", attemptId: "attempt-1", name: "Unit tests", command: "npm test -- upload-resume", status: "passed", exitCode: 0, durationMs: 12_480, evidenceDigest: "sha256:log001", outputPreview: "18 tests passed" },
  { id: "verify-2", attemptId: "attempt-1", name: "Browser recovery test", command: "npm run test:e2e -- upload-recovery", status: "failed", exitCode: 1, durationMs: 33_810, evidenceDigest: "sha256:log002", outputPreview: "Expected 62% restored progress, received 0%" },
  { id: "verify-3", attemptId: "attempt-2", name: "Unit tests", command: "npm test -- upload-resume", status: "passed", exitCode: 0, durationMs: 13_200, evidenceDigest: "sha256:log003", outputPreview: "21 tests passed" },
  { id: "verify-4", attemptId: "attempt-2", name: "Browser recovery test", command: "npm run test:e2e -- upload-recovery", status: "failed", exitCode: 1, durationMs: 38_190, evidenceDigest: "sha256:log004", outputPreview: "Token should rotate after checksum mismatch" },
  { id: "verify-5", attemptId: "attempt-3", name: "Focused unit tests", command: "npm test -- upload-resume", status: "running", exitCode: null, durationMs: null, evidenceDigest: null, outputPreview: "Running test 14 of 23..." },
];

export const requirements = [
  { id: "req-recovery", runId: "run-2048", revision: 1, position: 0, title: "Resume an interrupted upload", description: "Persist enough local state to continue after navigation or a browser restart.", acceptanceCriteria: "Given an upload interrupted after a confirmed chunk, reopening the project resumes from the last server-confirmed offset without re-uploading prior chunks.", status: "pass" as const, contentHash: "sha256:req01", evidenceIds: ["evidence-unit"], checkerSummary: "State restoration is covered by deterministic unit and browser evidence.", createdAt: ago(41), supersededAt: null },
  { id: "req-checksum", runId: "run-2048", revision: 1, position: 1, title: "Recover safely from checksum mismatch", description: "Invalidate stale server state before retrying a changed file.", acceptanceCriteria: "When the local checksum differs from the persisted upload, the client discards the old token, creates a new upload, and clearly reports why progress reset.", status: "fail" as const, contentHash: "sha256:req02", evidenceIds: ["evidence-browser"], checkerSummary: "Attempt 2 reused the stale token; attempt 3 is addressing this rejection.", createdAt: ago(41), supersededAt: null },
  { id: "req-controls", runId: "run-2048", revision: 1, position: 2, title: "Expose bounded operator retry", description: "Operators need visible recovery state and a safe manual retry.", acceptanceCriteria: "The UI shows the confirmed offset, last failure, and retry eligibility; retry cannot create concurrent upload sessions.", status: "missing" as const, contentHash: "sha256:req03", evidenceIds: [], checkerSummary: null, createdAt: ago(41), supersededAt: null },
];

export const evidence = [
  { id: "evidence-unit", runId: "run-2048", requirementId: "req-recovery", attemptId: "attempt-2", kind: "test" as const, status: "pass" as const, summary: "21 focused state persistence tests passed.", command: "npm test -- upload-resume", exitCode: 0, rawLogRef: "loop://artifacts/run-2048/unit.log", artifactDigest: "sha256:log003", producer: "vitest", provenance: "runtime" as const, createdAt: ago(13), expiresAt: null },
  { id: "evidence-browser", runId: "run-2048", requirementId: "req-checksum", attemptId: "attempt-2", kind: "test" as const, status: "fail" as const, summary: "Browser test observed reuse of the invalidated upload token.", command: "npm run test:e2e -- upload-recovery", exitCode: 1, rawLogRef: "loop://artifacts/run-2048/browser-recovery.log", artifactDigest: "sha256:log004", producer: "playwright", provenance: "runtime" as const, createdAt: ago(12), expiresAt: null },
];

export const reviews = [
  { id: "review-2", runId: "run-2048", attemptId: "attempt-2", checkerAgentId: "agent-checker-1", checkerSessionId: "ses_a1ca", artifactDigest: "sha256:72b4e3271f", verdict: "reject" as const, summary: "Persistence is correct, but checksum invalidation remains unsafe.", requirementResults: [{ requirementId: "req-recovery", status: "pass" as const, evidenceIds: ["evidence-unit"], note: "Evidence is current." }, { requirementId: "req-checksum", status: "fail" as const, evidenceIds: ["evidence-browser"], note: "Token rotation failed." }, { requirementId: "req-controls", status: "missing" as const, evidenceIds: [], note: "No UI evidence yet." }], createdAt: ago(12) },
];

export const worktrees = [
  { id: "wt-3", runId: "run-2048", attemptId: "attempt-3", path: "/worktrees/run-2048-attempt-3", branch: "loop/run-2048-a3", commit: null, dirty: true, status: "active" as const, createdAt: ago(11), updatedAt: ago(2) },
  { id: "wt-2", runId: "run-2048", attemptId: "attempt-2", path: "/worktrees/run-2048-attempt-2", branch: "loop/run-2048-a2", commit: "6f8a102", dirty: false, status: "rejected" as const, createdAt: ago(23), updatedAt: ago(12) },
];

export const approvals: ApprovalRecord[] = [
  { id: "approval-82", runId: "run-2047", stageId: "stage-human", status: "pending", requestedAction: "Modify shared authentication fixture", target: "tests/fixtures/auth-session.json", risk: "medium", evidenceDigest: "sha256:a11d4c", makerSummary: "Rotate the expired session fixture and pin its generated timestamp.", checkerVerdict: "approve", checkerSummary: "Change is scoped; 42 dependent tests pass with the new fixture.", requestedBy: "agent-maker-1", requestedAt: ago(12), expiresAt: later(48), decidedBy: null, decidedAt: null, decisionReason: null, version: 1 },
  { id: "approval-81", runId: "run-2046", stageId: "stage-human", status: "approved", requestedAction: "Publish release draft", target: "releases/v1.8.0-draft.md", risk: "low", evidenceDigest: "sha256:91c2ef", makerSummary: "Publish evidence-linked release notes draft.", checkerVerdict: "approve", checkerSummary: "All 17 claims have matching merged pull requests.", requestedBy: "release-agent", requestedAt: ago(180), expiresAt: ago(120), decidedBy: "local-admin", decidedAt: ago(172), decisionReason: "Evidence complete and release scope confirmed.", version: 2 },
  { id: "approval-80", runId: "run-2045", stageId: "stage-human", status: "rejected", requestedAction: "Accept dependency license exception", target: "packages/schema-parser", risk: "high", evidenceDigest: "sha256:52e1d1", makerSummary: "Accept GPL transitive dependency for local tooling.", checkerVerdict: "escalate_human", checkerSummary: "License conflicts with distribution policy.", requestedBy: "agent-maker-2", requestedAt: ago(300), expiresAt: ago(240), decidedBy: "security", decidedAt: ago(278), decisionReason: "Use an Apache-licensed alternative.", version: 2 },
];

export const artifacts: ArtifactRecord[] = [
  { id: "artifact-301", runId: "run-2048", attemptId: "attempt-2", name: "attempt-2.patch", kind: "diff", uri: "loop://artifacts/run-2048/attempt-2.patch", digest: "sha256:72b4e3271f", sizeBytes: 18432, createdAt: ago(12), producer: "agent-maker-1", verificationStatus: "invalid", sensitivity: "internal" },
  { id: "artifact-302", runId: "run-2048", attemptId: "attempt-2", name: "browser-recovery.log", kind: "log", uri: "loop://artifacts/run-2048/browser-recovery.log", digest: "sha256:log004", sizeBytes: 48102, createdAt: ago(12), producer: "playwright", verificationStatus: "verified", sensitivity: "internal" },
  { id: "artifact-303", runId: "run-2046", attemptId: null, name: "v1.8-release-notes.md", kind: "report", uri: "loop://artifacts/run-2046/release-notes.md", digest: "sha256:91c2ef", sizeBytes: 32180, createdAt: ago(172), producer: "release-agent", verificationStatus: "verified", sensitivity: "public" },
  { id: "artifact-304", runId: "run-2045", attemptId: "attempt-7", name: "license-scan.json", kind: "dataset", uri: "loop://artifacts/run-2045/license-scan.json", digest: "sha256:52e1d1", sizeBytes: 288110, createdAt: ago(218), producer: "license-checker", verificationStatus: "verified", sensitivity: "restricted" },
];

export const events: EventRecord[] = [
  { id: "event-38", runId: "run-2048", sequence: 38, stageId: "stage-maker", attemptId: "attempt-3", type: "tool.completed", severity: "info", message: "Read existing retry state machine and identified the invalidation branch.", payload: { tool: "read_file", path: "src/uploads/upload-resume.ts", durationMs: 82 }, provenance: "runtime", actor: "agent-maker-1", correlationId: "corr-38", artifactDigest: null, redacted: false, occurredAt: ago(1), receivedAt: ago(1) },
  { id: "event-37", runId: "run-2048", sequence: 37, stageId: "stage-maker", attemptId: "attempt-3", type: "file.changed", severity: "info", message: "Updated checksum mismatch handling to rotate the upload token.", payload: { path: "src/uploads/upload-resume.ts", additions: 18, deletions: 7 }, provenance: "runtime", actor: "agent-maker-1", correlationId: "corr-37", artifactDigest: null, redacted: false, occurredAt: ago(2), receivedAt: ago(2) },
  { id: "event-36", runId: "run-2048", sequence: 36, stageId: "stage-maker", attemptId: "attempt-3", type: "command.started", severity: "info", message: "Running focused upload recovery tests.", payload: { command: "npm test -- upload-resume" }, provenance: "runtime", actor: "agent-maker-1", correlationId: "corr-36", artifactDigest: null, redacted: false, occurredAt: ago(3), receivedAt: ago(3) },
  { id: "event-35", runId: "run-2048", sequence: 35, stageId: "stage-maker", attemptId: "attempt-3", type: "attempt.started", severity: "info", message: "Attempt 3 started from the checker rejection evidence.", payload: { previousAttempt: "attempt-2" }, provenance: "runtime", actor: "loop-controller", correlationId: "corr-35", artifactDigest: "sha256:72b4e3271f", redacted: false, occurredAt: ago(11), receivedAt: ago(11) },
  { id: "event-34", runId: "run-2048", sequence: 34, stageId: "stage-checker", attemptId: "attempt-2", type: "checker.rejected", severity: "warning", message: "Checker rejected attempt 2: stale upload token survives checksum mismatch.", payload: { verdict: "reject" }, provenance: "runtime", actor: "agent-checker-1", correlationId: "corr-34", artifactDigest: "sha256:72b4e3271f", redacted: false, occurredAt: ago(12), receivedAt: ago(12) },
  { id: "event-ci", runId: "run-2047", sequence: 27, stageId: "stage-human", attemptId: null, type: "approval.requested", severity: "warning", message: "Approval requested for shared authentication fixture update.", payload: {}, provenance: "runtime", actor: "loop-controller", correlationId: "corr-ci", artifactDigest: "sha256:a11d4c", redacted: false, occurredAt: ago(12), receivedAt: ago(12) },
];

export const audit: AuditRecord[] = [
  { id: "audit-19", runId: "run-2048", actor: "loop-controller", actorRole: "admin", action: "attempt.create", targetType: "attempt", targetId: "attempt-3", reason: "Checker rejected the previous immutable artifact", metadata: { previousAttempt: "attempt-2" }, createdAt: ago(11) },
  { id: "audit-18", runId: "run-2048", actor: "agent-checker-1", actorRole: "operator", action: "checker.reject", targetType: "attempt", targetId: "attempt-2", reason: "Checksum mismatch does not rotate token", metadata: { digest: "sha256:72b4e3271f" }, createdAt: ago(12) },
  { id: "audit-17", runId: "run-2047", actor: "loop-controller", actorRole: "admin", action: "approval.request", targetType: "approval", targetId: "approval-82", reason: "Policy requires approval for shared fixtures", metadata: { policy: "ci-v3" }, createdAt: ago(12) },
  { id: "audit-16", runId: "run-2046", actor: "local-admin", actorRole: "admin", action: "approval.approve", targetType: "approval", targetId: "approval-81", reason: "Evidence complete and release scope confirmed", metadata: {}, createdAt: ago(172) },
];

export const runDetail: RunDetailResponse = { run: runs[0], stages, attempts, requirements, evidence, reviews, verifications, approvals: [], artifacts: artifacts.filter((item) => item.runId === "run-2048"), worktrees, events: events.filter((item) => item.runId === "run-2048"), agents: agents.filter((item) => item.currentRunId === "run-2048"), audit: audit.filter((item) => item.runId === "run-2048") };

export const overview: OverviewResponse = {
  generatedAt: new Date(now).toISOString(),
  connection: { mode: "managed", status: "connected", lastEventAt: ago(1), globalPause: false },
  counts: { activeRuns: 2, waitingRuns: 1, pendingApprovals: 1, openBreakers: 2, staleAgents: 1 },
  metrics: { totalRuns: 4, terminalRuns: 2, succeededRuns: 1, unsuccessfulRuns: 1, successRatePct: 50 },
  attention: [
    { id: "attention-1", kind: "approval", severity: "warning", title: "Approval expires in 48 minutes", detail: "Shared authentication fixture update is waiting for an operator.", runId: "run-2047", createdAt: ago(12) },
    { id: "attention-2", kind: "breaker", severity: "critical", title: "Circuit breaker opened", detail: "Dependency upkeep repeated the same verification failure three times.", runId: "run-2045", createdAt: ago(215) },
    { id: "attention-3", kind: "stale_agent", severity: "critical", title: "Agent heartbeat is stale", detail: "Maker 02 has not reported telemetry for more than three hours.", runId: "run-2045", createdAt: ago(215) },
  ],
  activeRuns: runs.filter((run) => ["running", "waiting", "blocked"].includes(run.status)), loops, recentEvents: events,
};

export const mockFor = (path: string): unknown => {
  if (path === "/overview") return overview;
  if (path === "/loops") return loops;
  if (path === "/runs") return runs;
  if (path.match(/^\/runs\/[^/]+$/)) {
    const id = path.split("/").at(-1) ?? "run-2048";
    const run = runs.find((item) => item.id === id) ?? runs[0];
    if (run.id === "run-2048") return runDetail;
    return { ...runDetail, run, stages: stages.map((stage) => ({ ...stage, id: `${stage.id}-${id}`, runId: id, status: run.finishedAt ? "passed" : stage.position === 1 ? "passed" : stage.position === 2 ? "active" : "pending" })), attempts: [], requirements: [], evidence: [], reviews: [], verifications: [], approvals: approvals.filter((item) => item.runId === id), artifacts: artifacts.filter((item) => item.runId === id), worktrees: [], events: events.filter((item) => item.runId === id), agents: agents.filter((item) => item.currentRunId === id), audit: audit.filter((item) => item.runId === id) };
  }
  if (path === "/approvals") return approvals;
  if (path === "/agents") return agents;
  if (path === "/worktrees") return worktrees;
  if (path === "/artifacts") return artifacts;
  if (path === "/audit") return audit;
  if (path === "/settings/global-pause") return { paused: false, version: 1, changedAt: ago(0), changedBy: "system", reason: "Demo workspace" };
  if (path === "/session") return { user: { id: "local-admin", name: "Local admin" }, role: "admin", demo: true, dataMode: "demo", localOnly: true, permissions: { read: true, operate: true, administer: true } };
  return null;
};
