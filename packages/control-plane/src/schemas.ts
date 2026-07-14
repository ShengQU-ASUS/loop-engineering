import { z } from "zod";
import {
  AGENT_STATUSES,
  APPROVAL_STATUSES,
  PROVENANCE_TYPES,
  RUN_STATUSES,
  STAGE_STATUSES,
  WORKTREE_STATUSES,
} from "./types.js";

const nonEmpty = z.string().trim().min(1);
const nullableNonEmpty = nonEmpty.nullable().optional();

export const eventInputSchema = z.object({
  id: z.uuid().optional(),
  runId: nonEmpty,
  sequence: z.number().int().positive().optional(),
  stageId: nullableNonEmpty,
  attemptId: nullableNonEmpty,
  type: nonEmpty.max(120),
  severity: z.enum(["debug", "info", "warning", "error", "critical"]).default("info"),
  message: nonEmpty.max(20_000),
  payload: z.record(z.string(), z.unknown()).default({}),
  provenance: z.enum(PROVENANCE_TYPES),
  actor: nonEmpty.max(200),
  correlationId: nullableNonEmpty,
  artifactDigest: nullableNonEmpty,
  occurredAt: z.iso.datetime(),
});

export const createRunSchema = z.object({
  id: nonEmpty.optional(),
  loopId: nonEmpty,
  projectName: nonEmpty.max(200).default("Local project"),
  repositoryPath: nullableNonEmpty,
  runtime: nonEmpty.max(120).default("generic"),
  model: nonEmpty.max(200).default("configured default"),
  goal: nonEmpty.max(4_000),
  automationLevel: z.enum(["L1", "L2", "L3"]),
  risk: z.enum(["low", "medium", "high", "critical"]),
  sourceMode: z.enum(["managed", "snapshot"]).default("managed"),
  stages: z.array(z.object({
    key: nonEmpty,
    name: nonEmpty,
    role: z.enum(["system", "triage", "maker", "checker", "human"]),
  })).min(1),
  requirements: z.array(z.object({
    title: nonEmpty.max(500),
    description: nonEmpty.max(4_000),
    acceptanceCriteria: nonEmpty.max(4_000),
  })).default([]),
  budget: z.object({
    tokenLimit: z.number().int().positive(),
    costLimitUsd: z.number().nonnegative(),
    iterationLimit: z.number().int().positive(),
    warningPercent: z.number().int().min(1).max(99).default(80),
  }),
}).superRefine((input, context) => {
  if (input.sourceMode === "managed" && input.requirements.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["requirements"],
      message: "Managed runs require at least one signed acceptance requirement",
    });
  }
});

export const runActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "cancel", "retry", "override_breaker"]),
  reason: z.string().trim().max(2_000).optional(),
  expectedStatus: z.enum(RUN_STATUSES).optional(),
});

export const stageTransitionSchema = z.object({
  status: z.enum(STAGE_STATUSES),
  reason: z.string().trim().max(2_000).optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"] satisfies Array<(typeof APPROVAL_STATUSES)[number]>),
  reason: nonEmpty.max(4_000),
  expectedVersion: z.number().int().positive(),
});

export const checkerVerdictSchema = z.object({
  attemptId: nonEmpty,
  checkerAgentId: nonEmpty,
  checkerSessionId: nonEmpty,
  verdict: z.enum(["approve", "reject", "escalate_human", "error"]),
  summary: nonEmpty.max(10_000),
  artifactDigest: nonEmpty,
});

const factId = nonEmpty.max(200);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");
const optionalOccurredAt = z.iso.datetime().optional();
const runtimeFactBase = {
  id: factId,
  occurredAt: optionalOccurredAt,
};
const agentIdentity = {
  agentId: factId,
  sessionId: factId,
};

export const runtimeFactSchema = z.discriminatedUnion("type", [
  z.object({
    ...runtimeFactBase,
    type: z.literal("agent.heartbeat"),
    ...agentIdentity,
    name: nonEmpty.max(200),
    role: z.enum(["triage", "maker", "checker", "system"]),
    runtime: nonEmpty.max(120),
    model: nonEmpty.max(200),
    status: z.enum(AGENT_STATUSES).exclude(["stale"]),
    currentAction: z.string().trim().max(2_000).nullable().default(null),
    worktreePath: z.string().trim().min(1).max(4_000).nullable().default(null),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("attempt.started"),
    attemptId: factId,
    stageId: factId,
    makerAgentId: factId,
    makerSessionId: factId,
    number: z.number().int().positive().optional(),
    previousAttemptId: factId.nullable().default(null),
    feedbackReviewId: factId.nullable().default(null),
    feedbackSummary: z.string().trim().min(1).max(10_000).nullable().default(null),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("worktree.recorded"),
    worktreeId: factId,
    attemptId: factId,
    makerAgentId: factId,
    makerSessionId: factId,
    path: nonEmpty.max(4_000),
    branch: nonEmpty.max(500),
    commit: z.string().trim().min(1).max(500).nullable().default(null),
    dirty: z.boolean(),
    status: z.enum(WORKTREE_STATUSES),
    expectedVersion: z.number().int().nonnegative().default(0),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("attempt.artifact"),
    attemptId: factId,
    makerAgentId: factId,
    makerSessionId: factId,
    artifactDigest: sha256Digest,
    expectedArtifactDigest: sha256Digest.nullable().default(null),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("attempt.finished"),
    attemptId: factId,
    makerAgentId: factId,
    makerSessionId: factId,
    status: z.enum(["failure", "noop", "cancelled"]),
    summary: nonEmpty.max(10_000),
    errorSignature: z.string().trim().min(1).max(500).nullable().default(null),
    expectedStatus: z.literal("running").default("running"),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("verification.recorded"),
    verificationId: factId,
    attemptId: factId,
    agentId: factId,
    sessionId: factId,
    name: nonEmpty.max(500),
    command: nonEmpty.max(4_000),
    status: z.enum(["passed", "failed", "skipped"]),
    exitCode: z.number().int().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
    evidenceDigest: sha256Digest.nullable().default(null),
    artifactDigest: sha256Digest,
    outputPreview: z.string().max(20_000).nullable().default(null),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("requirement.evidence"),
    evidenceId: factId,
    requirementId: factId,
    attemptId: factId,
    agentId: factId,
    sessionId: factId,
    kind: z.enum(["command", "test", "diff", "artifact", "screenshot", "review", "other"]),
    status: z.enum(["pass", "fail", "missing"]),
    summary: nonEmpty.max(10_000),
    command: z.string().trim().min(1).max(4_000).nullable().default(null),
    exitCode: z.number().int().nullable().default(null),
    rawLogRef: z.string().trim().min(1).max(4_000).nullable().default(null),
    artifactDigest: sha256Digest,
    provenance: z.enum(["runtime", "agent_reported"]).default("runtime"),
    expiresAt: z.iso.datetime().nullable().default(null),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("artifact.recorded"),
    artifactId: factId,
    attemptId: factId,
    agentId: factId,
    sessionId: factId,
    name: nonEmpty.max(500),
    kind: z.enum(["diff", "report", "log", "dataset", "workbook", "other"]),
    uri: nonEmpty.max(4_000),
    digest: sha256Digest,
    sizeBytes: z.number().int().nonnegative(),
    verificationStatus: z.enum(["unverified", "verified", "invalid", "missing"]),
    sensitivity: z.enum(["public", "internal", "restricted"]),
  }).strict(),
  z.object({
    ...runtimeFactBase,
    type: z.literal("approval.requested"),
    approvalId: factId,
    stageId: factId,
    attemptId: factId,
    requestedByAgentId: factId,
    requestedBySessionId: factId,
    requestedAction: nonEmpty.max(500),
    target: nonEmpty.max(4_000),
    risk: z.enum(["low", "medium", "high", "critical"]),
    evidenceDigest: sha256Digest,
    makerSummary: nonEmpty.max(10_000),
    expiresAt: z.iso.datetime(),
  }).strict(),
]);

export type EventInput = z.infer<typeof eventInputSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunActionInput = z.infer<typeof runActionSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type CheckerVerdictInput = z.infer<typeof checkerVerdictSchema>;
export type RuntimeFactInput = z.infer<typeof runtimeFactSchema>;
