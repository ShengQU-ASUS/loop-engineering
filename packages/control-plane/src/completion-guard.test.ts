import { describe, expect, it } from "vitest";
import type { AttemptRecord, EvidenceRecord, RequirementRecord, ReviewRecord } from "./types.js";
import { CompletionGuardError, assertRunCanSucceed } from "./state-machine.js";

const attempt: AttemptRecord = {
  id: "attempt-2",
  runId: "run-1",
  stageId: "check",
  number: 2,
  status: "success",
  makerAgentId: "maker",
  makerSessionId: "maker-2",
  checkerAgentId: "checker",
  checkerSessionId: "checker-2",
  checkerStatus: "approve",
  checkerSummary: "All acceptance criteria have current evidence.",
  artifactDigest: "sha256:current",
  worktreePath: "/tmp/worktree",
  branch: "loop/run-1",
  previousAttemptId: null,
  feedbackReviewId: null,
  feedbackSummary: null,
  startedAt: "2026-07-15T01:00:00.000Z",
  finishedAt: "2026-07-15T01:10:00.000Z",
};

const requirement: RequirementRecord = {
  id: "req-1",
  runId: "run-1",
  revision: 1,
  position: 0,
  title: "Search returns matching runs",
  description: "An operator can search run history by goal.",
  acceptanceCriteria: "The integration test returns only matching runs.",
  status: "pass",
  contentHash: "sha256:req",
  evidenceIds: ["evidence-1"],
  checkerSummary: "Integration test passed.",
  createdAt: "2026-07-15T00:30:00.000Z",
  supersededAt: null,
};

const evidence: EvidenceRecord = {
  id: "evidence-1",
  runId: "run-1",
  requirementId: "req-1",
  attemptId: "attempt-2",
  kind: "test",
  status: "pass",
  summary: "Search API integration test passed.",
  command: "npm test -- search-api",
  exitCode: 0,
  rawLogRef: "event:42",
  artifactDigest: "sha256:current",
  producer: "verifier",
  provenance: "runtime",
  createdAt: "2026-07-15T01:08:00.000Z",
  expiresAt: null,
};

const review: ReviewRecord = {
  id: "review-1",
  runId: "run-1",
  attemptId: "attempt-2",
  checkerAgentId: "checker",
  checkerSessionId: "checker-2",
  artifactDigest: "sha256:current",
  verdict: "approve",
  summary: "Requirement verified independently.",
  requirementResults: [{
    requirementId: "req-1",
    status: "pass",
    evidenceIds: ["evidence-1"],
    note: "Cites deterministic integration output.",
  }],
  createdAt: "2026-07-15T01:09:00.000Z",
};

describe("completion guard", () => {
  it("accepts current passing evidence and a digest-bound checker approval", () => {
    expect(() => assertRunCanSucceed({
      requirements: [requirement],
      evidence: [evidence],
      reviews: [review],
      currentAttempt: attempt,
    })).not.toThrow();
  });

  it("rejects agent completion claims without deterministic evidence", () => {
    expect(() => assertRunCanSucceed({
      requirements: [requirement],
      evidence: [],
      reviews: [review],
      currentAttempt: attempt,
    })).toThrow(CompletionGuardError);
  });

  it("invalidates a checker verdict when the artifact changes", () => {
    expect(() => assertRunCanSucceed({
      requirements: [requirement],
      evidence: [evidence],
      reviews: [review],
      currentAttempt: { ...attempt, artifactDigest: "sha256:changed" },
    })).toThrow("current attempt");
  });

  it("rejects expired evidence", () => {
    expect(() => assertRunCanSucceed({
      requirements: [requirement],
      evidence: [{ ...evidence, expiresAt: "2026-07-15T01:09:30.000Z" }],
      reviews: [review],
      currentAttempt: attempt,
      now: Date.parse("2026-07-15T01:10:00.000Z"),
    })).toThrow("expired evidence");
  });
});
