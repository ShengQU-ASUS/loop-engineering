import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";

const SHA_A = "7f3c2d8a11b0952bcb8bd37da18457cfb56f27dd6141268df6f47d3814c379a1";
const SHA_B = "b8beaf3b612c00a93ed8c9921f03f1dbac2a14fa42ee96407d83caf72d2852cc";

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function ahead(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function seedDemoData(db: DatabaseSync): boolean {
  const count = db.prepare("SELECT COUNT(*) AS count FROM loops").get() as { count: number };
  if (count.count > 0) return false;

  transaction(db, () => {
    const insertSetting = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)");
    insertSetting.run("global_pause", "false");
    insertSetting.run("global_pause_version", "1");
    insertSetting.run("global_pause_changed_at", ago(0));
    insertSetting.run("global_pause_changed_by", "system");
    insertSetting.run("global_pause_reason", "Initial local state");

    const insertLoop = db.prepare(`INSERT INTO loops(id, name, description, automation_level, owner, schedule,
      risk, readiness_score, enabled, last_run_at, next_run_at, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertLoop.run("general-development", "General development", "Requirement-driven implementation with deterministic checks and an independent checker.",
      "L2", "Local user", null, "medium", 92, 1, ago(15), null, "policy-2026.07");
    insertLoop.run("dependency-maintenance", "Dependency maintenance", "Bounded dependency updates with compatibility evidence and human release gates.",
      "L2", "Local user", "0 9 * * 1", "medium", 86, 1, ago(1_440), ahead(8_640), "policy-2026.07");
    insertLoop.run("release-readiness", "Release readiness", "Audit release evidence, unresolved risk and delivery requirements without silently changing scope.",
      "L1", "Release owner", null, "high", 78, 1, ago(220), null, "policy-2026.07");

    const insertRun = db.prepare(`INSERT INTO runs(
      id, loop_id, goal, status, automation_level, risk, current_stage_id, waiting_reason, blocked_owner,
      unblock_condition, started_at, updated_at, finished_at, last_event_at, last_sequence, source_mode,
      token_limit, tokens_used, cost_limit_usd, cost_used_usd, iteration_limit, iterations_used, warning_percent,
      breaker_status, same_error_count, same_error_limit, consecutive_failures, consecutive_failure_limit,
      breaker_trigger, error_signature, breaker_opened_at, breaker_overridden_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    insertRun.run("run-webhook", "general-development",
      "Add resilient webhook delivery with idempotency, bounded retries, operator-visible evidence, and complete tests.",
      "running", "L2", "medium", "stage-webhook-maker", null, null, null,
      ago(52), ago(1), null, ago(1), 9, "managed", 120_000, 43_810, 18, 5.24, 12, 2, 80,
      "closed", 0, 3, 0, 5, null, null, null, null);
    insertRun.run("run-release", "release-readiness",
      "Verify the desktop release candidate against signed acceptance requirements and prepare the publish decision.",
      "waiting", "L2", "high", "stage-release-human", "Waiting for a scoped publish approval", null, null,
      ago(138), ago(4), null, ago(4), 8, "managed", 90_000, 68_240, 20, 10.82, 10, 3, 75,
      "warning", 1, 3, 1, 5, "Budget warning threshold reached", null, null, null);
    insertRun.run("run-deps", "dependency-maintenance",
      "Update the HTTP client while preserving proxy behavior, timeout semantics, and supported Node versions.",
      "capped", "L2", "medium", "stage-deps-checker", null, "Maintainer",
      "Choose a compatible client version or revise the Node support requirement", ago(240), ago(65), ago(65), ago(65), 7,
      "managed", 55_000, 55_000, 10, 9.31, 5, 5, 80, "open", 3, 3, 5, 5,
      "Iteration and token budgets exhausted after repeated compatibility failures", "ERR_UNSUPPORTED_NODE_RANGE", ago(65), null);

    db.prepare("UPDATE runs SET project_name = ?, repository_path = ?, runtime = ?, model = ? WHERE id = ?")
      .run("Webhook service", "/workspace/webhook-service", "Codex CLI", "gpt-5", "run-webhook");
    db.prepare("UPDATE runs SET project_name = ?, repository_path = ?, runtime = ?, model = ? WHERE id = ?")
      .run("Desktop application", "/workspace/desktop-app", "Claude Code + Codex checker", "sonnet / gpt-5", "run-release");
    db.prepare("UPDATE runs SET project_name = ?, repository_path = ?, runtime = ?, model = ? WHERE id = ?")
      .run("Platform SDK", "/workspace/platform-sdk", "OpenHands + Codex checker", "openhands / gpt-5", "run-deps");

    const insertStage = db.prepare(`INSERT INTO stages(id, run_id, key, name, position, role, status, started_at,
      finished_at, duration_ms, waiting_reason, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const stages = [
      ["stage-webhook-trigger", "run-webhook", "trigger", "Trigger", 0, "system", "passed", ago(52), ago(52), 24, null, null],
      ["stage-webhook-intake", "run-webhook", "intake", "Intake & requirements", 1, "triage", "passed", ago(52), ago(48), 240_000, null, null],
      ["stage-webhook-budget", "run-webhook", "budget", "Budget guard", 2, "system", "passed", ago(48), ago(48), 84, null, null],
      ["stage-webhook-maker", "run-webhook", "maker", "Maker implementation", 3, "maker", "active", ago(31), null, null, null, null],
      ["stage-webhook-verify", "run-webhook", "verify", "Deterministic verification", 4, "system", "pending", null, null, null, null, null],
      ["stage-webhook-checker", "run-webhook", "checker", "Independent checker", 5, "checker", "pending", null, null, null, null, null],
      ["stage-webhook-human", "run-webhook", "human", "Human gate", 6, "human", "pending", null, null, null, null, null],
      ["stage-webhook-persist", "run-webhook", "persist", "Persist state", 7, "system", "pending", null, null, null, null, null],
      ["stage-release-trigger", "run-release", "trigger", "Trigger", 0, "system", "passed", ago(138), ago(138), 20, null, null],
      ["stage-release-intake", "run-release", "intake", "Acceptance requirements", 1, "triage", "passed", ago(137), ago(126), 660_000, null, null],
      ["stage-release-maker", "run-release", "maker", "Release preparation", 2, "maker", "passed", ago(125), ago(74), 3_060_000, null, null],
      ["stage-release-verify", "run-release", "verify", "Deterministic verification", 3, "system", "passed", ago(73), ago(41), 1_920_000, null, null],
      ["stage-release-checker", "run-release", "checker", "Independent checker", 4, "checker", "passed", ago(40), ago(18), 1_320_000, null, null],
      ["stage-release-human", "run-release", "human", "Publish approval", 5, "human", "waiting", ago(17), null, null, "Waiting for release owner decision", null],
      ["stage-release-persist", "run-release", "persist", "Persist state", 6, "system", "pending", null, null, null, null, null],
      ["stage-deps-trigger", "run-deps", "trigger", "Trigger", 0, "system", "passed", ago(240), ago(240), 18, null, null],
      ["stage-deps-maker", "run-deps", "maker", "Dependency update", 1, "maker", "failed", ago(232), ago(75), 9_420_000, null, null],
      ["stage-deps-checker", "run-deps", "checker", "Compatibility checker", 2, "checker", "blocked", ago(74), null, null, "Circuit breaker opened after repeated unsupported Node failures", null],
      ["stage-deps-human", "run-deps", "human", "Scope decision", 3, "human", "pending", null, null, null, null, null],
    ] as const;
    for (const stage of stages) insertStage.run(...stage);

    const insertAttempt = db.prepare(`INSERT INTO attempts(id, run_id, stage_id, number, status, maker_agent_id,
      maker_session_id, checker_agent_id, checker_session_id, checker_status, checker_summary, artifact_digest,
      worktree_path, branch, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertAttempt.run("attempt-webhook-1", "run-webhook", "stage-webhook-maker", 1, "rejected", "agent-maker", "session-maker-001",
      "agent-checker", "session-checker-001", "reject", "Retry jitter was not bounded and the idempotency test missed concurrent deliveries.", SHA_A,
      "/workspace/.worktrees/webhook-1", "loop/webhook-attempt-1", ago(49), ago(33));
    insertAttempt.run("attempt-webhook-2", "run-webhook", "stage-webhook-maker", 2, "running", "agent-maker", "session-maker-002",
      null, null, "pending", null, SHA_B, "/workspace/.worktrees/webhook-2", "loop/webhook-attempt-2", ago(31), null);
    insertAttempt.run("attempt-release-1", "run-release", "stage-release-maker", 1, "success", "agent-release-maker", "session-release-maker",
      "agent-release-checker", "session-release-checker", "approve", "All signed requirements have current deterministic evidence.", SHA_B,
      "/workspace/.worktrees/release", "release/verify-candidate", ago(125), ago(18));
    for (let index = 1; index <= 3; index += 1) {
      insertAttempt.run(`attempt-deps-${index}`, "run-deps", "stage-deps-maker", index, "failure", "agent-maintainer", `session-deps-maker-${index}`,
        "agent-deps-checker", `session-deps-checker-${index}`, "reject", "Supported Node range is incompatible with this dependency release.", SHA_A,
        `/workspace/.worktrees/deps-${index}`, `deps/http-client-attempt-${index}`, ago(230 - index * 40), ago(205 - index * 40));
    }

    const insertReq = db.prepare(`INSERT INTO requirements(id, run_id, revision, position, title, description,
      acceptance_criteria, status, content_hash, evidence_ids_json, checker_summary, created_at, superseded_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
    insertReq.run("req-webhook-idempotency", "run-webhook", 0, "Idempotent delivery", "Concurrent deliveries must not execute the same logical event twice.",
      "A concurrency test with at least 20 parallel duplicate deliveries records one handler execution.", "fail", SHA_A,
      JSON.stringify(["evidence-webhook-concurrency"]), "Attempt 1 test did not exercise concurrent requests; attempt 2 evidence is pending.", ago(52));
    insertReq.run("req-webhook-retry", "run-webhook", 1, "Bounded retry policy", "Transient errors retry with capped exponential backoff and jitter.",
      "Unit tests prove max attempts, maximum delay and permanent-error handling.", "pass", SHA_B,
      JSON.stringify(["evidence-webhook-unit"]), "Unit evidence covers all retry boundaries.", ago(52));
    insertReq.run("req-webhook-observe", "run-webhook", 2, "Operator-visible evidence", "Each delivery exposes a stable correlation ID and terminal outcome.",
      "Integration test verifies structured events without leaking request credentials.", "pending", SHA_B, "[]", null, ago(52));
    insertReq.run("req-release-tests", "run-release", 0, "Complete automated test suite", "All required test groups pass on the release commit.",
      "Unit, integration and end-to-end suites exit zero against the candidate digest.", "pass", SHA_B,
      JSON.stringify(["evidence-release-tests"]), "Evidence digest matches the release candidate.", ago(137));
    insertReq.run("req-release-sign", "run-release", 1, "Signed distributable", "Generated distributable is signed and checksum recorded.",
      "Signature verification exits zero and published checksum equals the reviewed artifact digest.", "pass", SHA_B,
      JSON.stringify(["evidence-release-signature"]), "Signature and artifact digest verified independently.", ago(137));
    insertReq.run("req-deps-node", "run-deps", 0, "Supported Node versions", "The client must run on every Node version declared by the package.",
      "The compatibility matrix passes on Node 20, 22 and 24.", "fail", SHA_A,
      JSON.stringify(["evidence-deps-node"]), "Node 20 fails before tests start; no compliant artifact exists.", ago(239));

    const insertEvidence = db.prepare(`INSERT INTO evidence(id, run_id, requirement_id, attempt_id, kind, status,
      summary, command, exit_code, raw_log_ref, artifact_digest, producer, provenance, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertEvidence.run("evidence-webhook-concurrency", "run-webhook", "req-webhook-idempotency", "attempt-webhook-1", "test", "fail",
      "The test issued sequential duplicates and cannot prove concurrency safety.", "npm test -- webhook-concurrency", 0,
      "artifact://log/webhook-attempt-1", SHA_A, "agent-checker", "runtime", ago(34), null);
    insertEvidence.run("evidence-webhook-unit", "run-webhook", "req-webhook-retry", "attempt-webhook-2", "test", "pass",
      "18 retry boundary tests passed.", "npm test -- webhook-retry", 0, "artifact://log/webhook-attempt-2", SHA_B,
      "runtime:test-runner", "runtime", ago(3), null);
    insertEvidence.run("evidence-release-tests", "run-release", "req-release-tests", "attempt-release-1", "test", "pass",
      "Unit, integration and end-to-end suites passed: 418 tests.", "npm run test:all", 0, "artifact://log/release-tests", SHA_B,
      "runtime:test-runner", "runtime", ago(39), ahead(1_440));
    insertEvidence.run("evidence-release-signature", "run-release", "req-release-sign", "attempt-release-1", "command", "pass",
      "Signature validation and SHA-256 comparison passed.", "npm run verify:release", 0, "artifact://log/release-signature", SHA_B,
      "agent-release-checker", "runtime", ago(22), ahead(1_440));
    insertEvidence.run("evidence-deps-node", "run-deps", "req-deps-node", "attempt-deps-3", "test", "fail",
      "Dependency requires Node >=22 while the project supports Node 20.", "npm run test:matrix", 1, "artifact://log/deps-node-matrix", SHA_A,
      "runtime:test-runner", "runtime", ago(76), null);

    const insertVerification = db.prepare(`INSERT INTO verifications(id, attempt_id, name, command, status, exit_code,
      duration_ms, evidence_digest, output_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertVerification.run("verify-webhook-unit", "attempt-webhook-2", "Webhook retry tests", "npm test -- webhook-retry", "passed", 0, 8_412, SHA_B, "18 passed, 0 failed");
    insertVerification.run("verify-webhook-types", "attempt-webhook-2", "TypeScript", "npm run typecheck", "passed", 0, 4_941, SHA_B, "No type errors");
    insertVerification.run("verify-release-all", "attempt-release-1", "Release test matrix", "npm run test:all", "passed", 0, 1_820_400, SHA_B, "418 passed");
    insertVerification.run("verify-deps-node", "attempt-deps-3", "Node compatibility matrix", "npm run test:matrix", "failed", 1, 7_118, SHA_A, "Unsupported engine on Node 20");

    db.prepare(`INSERT INTO reviews(id, run_id, attempt_id, checker_agent_id, checker_session_id, artifact_digest,
      verdict, summary, requirement_results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("review-webhook-1", "run-webhook", "attempt-webhook-1", "agent-checker", "session-checker-001", SHA_A, "reject",
        "Retry logic is close, but the concurrency requirement lacks valid evidence.", JSON.stringify([
          { requirementId: "req-webhook-idempotency", status: "fail", evidenceIds: ["evidence-webhook-concurrency"], note: "Sequential execution is insufficient." },
          { requirementId: "req-webhook-retry", status: "pass", evidenceIds: [], note: "Boundaries are covered." },
          { requirementId: "req-webhook-observe", status: "missing", evidenceIds: [], note: "No redaction test attached." },
        ]), ago(33));
    db.prepare(`INSERT INTO reviews(id, run_id, attempt_id, checker_agent_id, checker_session_id, artifact_digest,
      verdict, summary, requirement_results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("review-release-1", "run-release", "attempt-release-1", "agent-release-checker", "session-release-checker", SHA_B, "approve",
        "Candidate digest satisfies all signed requirements with current deterministic evidence.", JSON.stringify([
          { requirementId: "req-release-tests", status: "pass", evidenceIds: ["evidence-release-tests"], note: "All suites passed." },
          { requirementId: "req-release-sign", status: "pass", evidenceIds: ["evidence-release-signature"], note: "Signature verified." },
        ]), ago(18));

    db.prepare(`INSERT INTO approvals(id, run_id, stage_id, status, requested_action, target, risk, evidence_digest,
      maker_summary, checker_verdict, checker_summary, requested_by, requested_at, expires_at, version)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run("approval-release", "run-release", "stage-release-human", "Publish signed desktop release",
        "release/v2.4.0 candidate b8beaf3", "high", SHA_B, "Candidate is signed; 418 tests pass.", "approve",
        "Independent checker verified requirement evidence and candidate digest.", "agent-release-maker", ago(17), ahead(103));

    const insertAgent = db.prepare(`INSERT INTO agents(id, name, role, runtime, model, status, current_run_id,
      current_action, last_heartbeat_at, session_id, worktree_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertAgent.run("agent-maker", "Maker 02", "maker", "Codex CLI", "gpt-5", "running", "run-webhook",
      "Implementing concurrent idempotency test and request redaction", ago(1), "session-maker-002", "/workspace/.worktrees/webhook-2");
    insertAgent.run("agent-checker", "Checker 01", "checker", "Codex CLI", "gpt-5", "waiting", "run-webhook",
      "Waiting for attempt 2 evidence digest", ago(2), "session-checker-002", "/workspace/.worktrees/webhook-checker");
    insertAgent.run("agent-release-maker", "Release Maker", "maker", "Claude Code", "sonnet", "waiting", "run-release",
      "Waiting for scoped publish approval", ago(4), "session-release-maker", "/workspace/.worktrees/release");
    insertAgent.run("agent-release-checker", "Release Checker", "checker", "Codex CLI", "gpt-5", "finished", "run-release",
      "Independent verification complete", ago(18), "session-release-checker", "/workspace/.worktrees/release-checker");
    insertAgent.run("agent-maintainer", "Maintenance Maker", "maker", "OpenHands", "openhands", "stale", "run-deps",
      "Stopped after circuit breaker opened", ago(65), "session-deps-maker-3", "/workspace/.worktrees/deps-3");

    const insertWorktree = db.prepare(`INSERT INTO worktrees(id, run_id, attempt_id, path, branch, commit_hash, dirty,
      status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertWorktree.run("worktree-webhook-1", "run-webhook", "attempt-webhook-1", "/workspace/.worktrees/webhook-1", "loop/webhook-attempt-1", "8a71d3e", 1, "rejected", ago(49), ago(33));
    insertWorktree.run("worktree-webhook-2", "run-webhook", "attempt-webhook-2", "/workspace/.worktrees/webhook-2", "loop/webhook-attempt-2", "d4c98b1", 1, "active", ago(31), ago(1));
    insertWorktree.run("worktree-release", "run-release", "attempt-release-1", "/workspace/.worktrees/release", "release/verify-candidate", "b8beaf3", 0, "escalated", ago(125), ago(17));
    insertWorktree.run("worktree-deps-3", "run-deps", "attempt-deps-3", "/workspace/.worktrees/deps-3", "deps/http-client-attempt-3", "7f3c2d8", 1, "stale", ago(150), ago(65));

    const insertArtifact = db.prepare(`INSERT INTO artifacts(id, run_id, attempt_id, name, kind, uri, digest, size_bytes,
      created_at, producer, verification_status, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertArtifact.run("artifact-webhook-diff-1", "run-webhook", "attempt-webhook-1", "attempt-1.patch", "diff", "artifact://diff/webhook-1", SHA_A, 18_412, ago(34), "agent-maker", "invalid", "internal");
    insertArtifact.run("artifact-webhook-diff-2", "run-webhook", "attempt-webhook-2", "attempt-2.patch", "diff", "artifact://diff/webhook-2", SHA_B, 24_906, ago(2), "agent-maker", "unverified", "internal");
    insertArtifact.run("artifact-release", "run-release", "attempt-release-1", "desktop-v2.4.0.zip", "other", "artifact://release/desktop-v2.4.0.zip", SHA_B, 84_200_910, ago(74), "agent-release-maker", "verified", "restricted");
    insertArtifact.run("artifact-release-report", "run-release", "attempt-release-1", "release-evidence.md", "report", "artifact://report/release-evidence", SHA_B, 31_088, ago(18), "agent-release-checker", "verified", "internal");

    const insertEvent = db.prepare(`INSERT INTO events(id, run_id, sequence, stage_id, attempt_id, type, severity,
      message, payload_json, provenance, actor, correlation_id, artifact_digest, redacted, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
    const event = (id: string, runId: string, sequence: number, stageId: string | null, attemptId: string | null,
      type: string, severity: string, message: string, payload: object, provenance: string, actor: string,
      digest: string | null, minutes: number) => insertEvent.run(id, runId, sequence, stageId, attemptId, type, severity,
        message, JSON.stringify(payload), provenance, actor, null, digest, ago(minutes), ago(minutes));
    event("event-webhook-1", "run-webhook", 1, "stage-webhook-trigger", null, "run.started", "info", "Run accepted by local controller", {}, "runtime", "controller", null, 52);
    event("event-webhook-2", "run-webhook", 2, "stage-webhook-intake", null, "requirements.signed", "info", "Three acceptance requirements recorded", { count: 3, revision: 1 }, "human", "local-user", null, 48);
    event("event-webhook-3", "run-webhook", 3, "stage-webhook-maker", "attempt-webhook-1", "attempt.started", "info", "Maker attempt 1 started in isolated worktree", { branch: "loop/webhook-attempt-1" }, "runtime", "agent-maker", null, 49);
    event("event-webhook-4", "run-webhook", 4, "stage-webhook-checker", "attempt-webhook-1", "checker.rejected", "warning", "Checker rejected insufficient concurrency evidence", { requirementId: "req-webhook-idempotency" }, "runtime", "agent-checker", SHA_A, 33);
    event("event-webhook-5", "run-webhook", 5, "stage-webhook-maker", "attempt-webhook-2", "attempt.started", "info", "Maker attempt 2 started; attempt 1 remains immutable", { branch: "loop/webhook-attempt-2" }, "runtime", "agent-maker", null, 31);
    event("event-webhook-6", "run-webhook", 6, "stage-webhook-maker", "attempt-webhook-2", "file.changed", "info", "Added transactional delivery claim and concurrent test fixture", { files: ["src/delivery.ts", "test/webhook-concurrency.test.ts"] }, "runtime", "agent-maker", SHA_B, 8);
    event("event-webhook-7", "run-webhook", 7, "stage-webhook-maker", "attempt-webhook-2", "verification.passed", "info", "Retry boundary tests passed", { passed: 18, failed: 0, durationMs: 8412 }, "runtime", "runtime:test-runner", SHA_B, 3);
    event("event-webhook-8", "run-webhook", 8, "stage-webhook-maker", "attempt-webhook-2", "verification.passed", "info", "TypeScript check passed", { durationMs: 4941 }, "runtime", "runtime:test-runner", SHA_B, 2);
    event("event-webhook-9", "run-webhook", 9, "stage-webhook-maker", "attempt-webhook-2", "agent.checkpoint", "info", "Preparing full concurrency and redaction verification", { next: "npm test -- webhook-concurrency webhook-redaction" }, "agent_reported", "agent-maker", SHA_B, 1);
    event("event-release-1", "run-release", 1, "stage-release-trigger", null, "run.started", "info", "Release verification started", {}, "runtime", "controller", null, 138);
    event("event-release-2", "run-release", 2, "stage-release-intake", null, "requirements.signed", "info", "Release owner signed two acceptance requirements", { count: 2 }, "human", "release-owner", null, 126);
    event("event-release-3", "run-release", 3, "stage-release-maker", "attempt-release-1", "artifact.created", "info", "Signed release candidate created", { artifactId: "artifact-release" }, "runtime", "agent-release-maker", SHA_B, 74);
    event("event-release-4", "run-release", 4, "stage-release-verify", "attempt-release-1", "verification.passed", "info", "418 automated tests passed", { tests: 418 }, "runtime", "runtime:test-runner", SHA_B, 39);
    event("event-release-5", "run-release", 5, "stage-release-checker", "attempt-release-1", "checker.started", "info", "Independent checker bound to candidate digest", {}, "runtime", "agent-release-checker", SHA_B, 40);
    event("event-release-6", "run-release", 6, "stage-release-checker", "attempt-release-1", "checker.approved", "info", "Independent checker approved current requirement evidence", { requirementsPassed: 2 }, "runtime", "agent-release-checker", SHA_B, 18);
    event("event-release-7", "run-release", 7, "stage-release-human", "attempt-release-1", "approval.requested", "warning", "Publish action requires a scoped human decision", { approvalId: "approval-release" }, "runtime", "controller", SHA_B, 17);
    event("event-release-8", "run-release", 8, "stage-release-human", "attempt-release-1", "run.waiting", "info", "Run waiting for release owner", { reason: "Scoped publish approval" }, "runtime", "controller", SHA_B, 4);
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      event(`event-deps-${sequence}`, "run-deps", sequence, sequence < 7 ? "stage-deps-maker" : "stage-deps-checker",
        sequence > 1 ? `attempt-deps-${Math.min(Math.ceil(sequence / 2), 3)}` : null,
        sequence === 7 ? "breaker.opened" : sequence % 2 === 0 ? "verification.failed" : "attempt.started",
        sequence === 7 ? "critical" : sequence % 2 === 0 ? "error" : "info",
        sequence === 7 ? "Circuit breaker opened: budgets exhausted without a compatible artifact" : sequence % 2 === 0 ? "Node 20 compatibility check failed" : `Maker attempt ${Math.min(Math.ceil(sequence / 2), 3)} started`,
        sequence === 7 ? { sameErrorCount: 3, iterationsUsed: 5, tokenPercent: 100 } : {}, "runtime", "controller", SHA_A, 240 - sequence * 25);
    }

    const insertAudit = db.prepare(`INSERT INTO audit_log(id, run_id, actor, actor_role, action, target_type,
      target_id, reason, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertAudit.run("audit-webhook-create", "run-webhook", "local-user", "admin", "run.create", "run", "run-webhook", null, "{}", ago(52));
    insertAudit.run("audit-webhook-reject", "run-webhook", "agent-checker", "operator", "checker.verdict", "attempt", "attempt-webhook-1",
      "Concurrency evidence did not satisfy the signed criterion", JSON.stringify({ artifactDigest: SHA_A, verdict: "reject" }), ago(33));
    insertAudit.run("audit-release-request", "run-release", "controller", "operator", "approval.request", "approval", "approval-release", null,
      JSON.stringify({ action: "Publish signed desktop release", digest: SHA_B }), ago(17));
    insertAudit.run("audit-deps-breaker", "run-deps", "controller", "admin", "breaker.open", "run", "run-deps",
      "Token and iteration budgets exhausted", JSON.stringify({ signature: "ERR_UNSUPPORTED_NODE_RANGE", repeats: 3 }), ago(65));
  });
  return true;
}

export function ensureBaseData(db: DatabaseSync): void {
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('global_pause', 'false')").run();
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('global_pause_version', '1')").run();
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('global_pause_changed_at', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('global_pause_changed_by', 'system')").run();
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('global_pause_reason', 'Initial local state')").run();
  const count = db.prepare("SELECT COUNT(*) AS count FROM loops").get() as { count: number };
  if (count.count > 0) return;
  db.prepare(`INSERT INTO loops(id, name, description, automation_level, owner, schedule,
    risk, readiness_score, enabled, last_run_at, next_run_at, policy_version)
    VALUES ('general-development', 'General development',
      'Requirement-driven implementation with deterministic checks and an independent checker.',
      'L2', 'Local user', NULL, 'medium', 90, 1, NULL, NULL, 'policy-default')`).run();
}
