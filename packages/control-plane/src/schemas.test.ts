import { describe, expect, it } from "vitest";
import { approvalDecisionSchema, createRunSchema, eventInputSchema, runtimeFactSchema } from "./schemas.js";

describe("control-plane schemas", () => {
  it("accepts an observable runtime event", () => {
    const result = eventInputSchema.parse({
      runId: "run-1",
      type: "tool.completed",
      message: "npm test exited 0",
      payload: { command: "npm test", exitCode: 0 },
      provenance: "runtime",
      actor: "worker-1",
      occurredAt: "2026-07-15T01:00:00.000Z",
    });
    expect(result.severity).toBe("info");
  });

  it("requires a real stage template and finite budget", () => {
    const valid = {
      loopId: "feature-development",
      goal: "Implement searchable run history",
      automationLevel: "L2",
      risk: "medium",
      stages: [{ key: "plan", name: "Plan", role: "triage" }],
      requirements: [{
        title: "Search works",
        description: "Run history can be searched",
        acceptanceCriteria: "A test proves matching runs are returned",
      }],
      budget: { tokenLimit: 100_000, costLimitUsd: 25, iterationLimit: 5 },
    };
    expect(createRunSchema.parse(valid).budget.warningPercent).toBe(80);
    expect(createRunSchema.parse(valid).projectName).toBe("Local project");
    expect(() => createRunSchema.parse({ ...valid, stages: [] })).toThrow();
    expect(() => createRunSchema.parse({ ...valid, budget: { ...valid.budget, iterationLimit: 0 } })).toThrow();
    expect(() => createRunSchema.parse({ ...valid, requirements: [] })).toThrow(
      "Managed runs require at least one signed acceptance requirement",
    );
    expect(createRunSchema.parse({ ...valid, sourceMode: "snapshot", requirements: [] }).requirements).toEqual([]);
  });

  it("requires optimistic concurrency and a reason for approval decisions", () => {
    expect(approvalDecisionSchema.parse({
      decision: "approved",
      reason: "Checker evidence and deterministic tests passed",
      expectedVersion: 1,
    }).decision).toBe("approved");
    expect(() => approvalDecisionSchema.parse({ decision: "rejected", reason: "", expectedVersion: 1 })).toThrow();
  });

  it("validates structured runtime facts and SHA-256 bindings", () => {
    const fact = runtimeFactSchema.parse({
      id: "fact-artifact-1",
      type: "attempt.artifact",
      attemptId: "attempt-1",
      makerAgentId: "maker-1",
      makerSessionId: "maker-session-1",
      artifactDigest: "a".repeat(64),
    });
    if (fact.type !== "attempt.artifact") throw new Error("Unexpected runtime fact type");
    expect(fact.expectedArtifactDigest).toBeNull();
    expect(() => runtimeFactSchema.parse({ ...fact, artifactDigest: "not-a-digest" })).toThrow();
  });
});
