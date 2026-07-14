import type {
  AttemptRecord,
  EvidenceRecord,
  RequirementRecord,
  ReviewRecord,
  RunStatus,
  StageStatus,
} from "./types.js";

const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["running", "paused", "cancelled"]),
  running: new Set(["waiting", "paused", "blocked", "capped", "succeeded", "failed", "timed_out", "cancelled"]),
  waiting: new Set(["running", "paused", "blocked", "capped", "failed", "timed_out", "cancelled"]),
  paused: new Set(["running", "blocked", "capped", "cancelled"]),
  blocked: new Set(["running", "capped", "failed", "cancelled"]),
  capped: new Set(),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
};

const STAGE_TRANSITIONS: Record<StageStatus, ReadonlySet<StageStatus>> = {
  pending: new Set(["active", "skipped", "blocked"]),
  active: new Set(["waiting", "passed", "rejected", "failed", "blocked"]),
  waiting: new Set(["active", "passed", "rejected", "failed", "blocked"]),
  passed: new Set(),
  rejected: new Set(),
  failed: new Set(),
  skipped: new Set(),
  blocked: new Set(["active", "failed", "skipped"]),
};

export class InvalidTransitionError extends Error {
  constructor(domain: "run" | "stage", from: string, to: string) {
    super(`Invalid ${domain} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].has(to)) throw new InvalidTransitionError("run", from, to);
}

export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  if (!STAGE_TRANSITIONS[from].has(to)) throw new InvalidTransitionError("stage", from, to);
}

export function isTerminalRun(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].size === 0;
}

export function assertIndependentChecker(
  makerAgentId: string,
  makerSessionId: string,
  checkerAgentId: string,
  checkerSessionId: string,
): void {
  if (makerAgentId === checkerAgentId || makerSessionId === checkerSessionId) {
    throw new Error("Maker and checker must use independent agents and sessions");
  }
}

export function assertMatchingDigest(expected: string | null, actual: string): void {
  if (!expected) throw new Error("Attempt has no artifact digest to verify");
  if (expected !== actual) throw new Error("Checker verdict does not match the current artifact digest");
}

export function actionRequiresReason(action: string): boolean {
  return ["pause", "resume", "cancel", "override_breaker", "reject", "request_changes"].includes(action);
}

export class CompletionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionGuardError";
  }
}

export function assertRunCanSucceed(input: {
  requirements: RequirementRecord[];
  evidence: EvidenceRecord[];
  reviews: ReviewRecord[];
  currentAttempt: AttemptRecord | null;
  now?: number;
}): void {
  const currentRequirements = input.requirements.filter((requirement) => !requirement.supersededAt);
  if (currentRequirements.length === 0) {
    throw new CompletionGuardError("A run cannot succeed without current requirements");
  }
  if (!input.currentAttempt?.artifactDigest) {
    throw new CompletionGuardError("A run cannot succeed without a current artifact digest");
  }

  const review = [...input.reviews]
    .reverse()
    .find((candidate) =>
      candidate.attemptId === input.currentAttempt?.id &&
      candidate.artifactDigest === input.currentAttempt?.artifactDigest,
    );
  if (!review || review.verdict !== "approve") {
    throw new CompletionGuardError("A run cannot succeed without an independent approval for the current attempt");
  }

  const now = input.now ?? Date.now();
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const resultsByRequirement = new Map(review.requirementResults.map((result) => [result.requirementId, result]));

  for (const requirement of currentRequirements) {
    const result = resultsByRequirement.get(requirement.id);
    if (!result || result.status !== "pass") {
      throw new CompletionGuardError(`Requirement ${requirement.id} is not passed by the checker`);
    }
    if (result.evidenceIds.length === 0) {
      throw new CompletionGuardError(`Requirement ${requirement.id} has no cited evidence`);
    }
    for (const evidenceId of result.evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (!item || item.requirementId !== requirement.id || item.status !== "pass") {
        throw new CompletionGuardError(`Requirement ${requirement.id} cites invalid evidence ${evidenceId}`);
      }
      if (item.expiresAt && Date.parse(item.expiresAt) <= now) {
        throw new CompletionGuardError(`Requirement ${requirement.id} cites expired evidence ${evidenceId}`);
      }
      if (item.artifactDigest && item.artifactDigest !== input.currentAttempt.artifactDigest) {
        throw new CompletionGuardError(`Requirement ${requirement.id} evidence does not match the current artifact`);
      }
    }
  }
}
