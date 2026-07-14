// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server/app.js";
import { assertSecureBind } from "../server/auth.js";
import { openDatabase, transaction } from "../server/database.js";
import { seedDemoData } from "../server/seed.js";

const OPERATOR = { "x-loop-role": "operator", "x-loop-actor": "test-operator" };
const ADMIN = { "x-loop-role": "admin", "x-loop-actor": "test-admin" };
const VIEWER = { "x-loop-role": "viewer", "x-loop-actor": "test-viewer" };
const SHA_B = "b8beaf3b612c00a93ed8c9921f03f1dbac2a14fa42ee96407d83caf72d2852cc";
const TEST_REQUIREMENTS = [{
  title: "Requested outcome",
  description: "The requested development outcome must be delivered without regressions.",
  acceptanceCriteria: "A deterministic verification proves the requested outcome and existing tests pass.",
}];

describe("Loop Engineering Admin API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function demoApp(): Promise<FastifyInstance> {
    app = await buildApp({ databasePath: ":memory:", demo: true, demoRunSourceMode: "managed", enableTestAuthHeaders: true });
    await app.ready();
    return app;
  }

  async function freshApp(): Promise<FastifyInstance> {
    app = await buildApp({ databasePath: ":memory:", demo: false, enableTestAuthHeaders: true });
    await app.ready();
    return app;
  }

  async function activateStageInOrder(api: FastifyInstance, runId: string, targetStageId: string): Promise<any> {
    const detail = (await api.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const target = detail.stages.find((stage: any) => stage.id === targetStageId);
    if (!target) throw new Error(`Missing target stage ${targetStageId}`);
    for (const stage of detail.stages.filter((candidate: any) => candidate.position <= target.position)) {
      if (["passed", "skipped"].includes(stage.status)) continue;
      if (stage.status === "pending") {
        const activated = await api.inject({
          method: "PATCH",
          url: `/api/runs/${runId}/stages/${stage.id}`,
          headers: OPERATOR,
          payload: { status: "active" },
        });
        expect(activated.statusCode).toBe(200);
      }
      if (stage.id === targetStageId) return (await api.inject({ method: "GET", url: `/api/runs/${runId}` }))
        .json().stages.find((candidate: any) => candidate.id === targetStageId);
      const passed = await api.inject({
        method: "PATCH",
        url: `/api/runs/${runId}/stages/${stage.id}`,
        headers: OPERATOR,
        payload: { status: "passed" },
      });
      expect(passed.statusCode).toBe(200);
    }
    throw new Error(`Unable to activate target stage ${targetStageId}`);
  }

  it("initializes a fresh operational workspace without fake execution records", async () => {
    const api = await freshApp();
    expect((await api.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
      demo: false,
      dataMode: "operational",
    });
    expect((await api.inject({ method: "GET", url: "/api/loops" })).json()).toMatchObject([{
      id: "general-development",
      name: "General development",
      enabled: true,
    }]);
    expect((await api.inject({ method: "GET", url: "/api/runs" })).json()).toEqual([]);
    expect((await api.inject({ method: "GET", url: "/api/agents" })).json()).toEqual([]);
    expect((await api.inject({ method: "GET", url: "/api/events" })).json()).toEqual([]);
    expect((await api.inject({ method: "GET", url: "/api/approvals" })).json()).toEqual([]);
    expect((await api.inject({ method: "GET", url: "/api/audit" })).json()).toEqual([]);
    expect((await api.inject({ method: "GET", url: "/api/settings/global-pause" })).json()).toMatchObject({
      paused: false,
      version: 1,
    });
    expect((await api.inject({ method: "GET", url: "/api/overview" })).json()).toMatchObject({
      connection: {
        mode: "managed",
        status: "connected",
        lastEventAt: null,
      },
    });
  });

  it("stores opt-in demo identity and truthful snapshot provenance across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-admin-demo-"));
    const databasePath = join(directory, "demo.db");
    try {
      app = await buildApp({ databasePath, demo: true });
      await app.ready();
      expect((await app.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
        demo: true,
        dataMode: "demo",
        permissions: { read: true, operate: false, administer: false },
      });
      const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
      expect(runs).toHaveLength(3);
      expect(runs.every((run: any) => run.sourceMode === "snapshot")).toBe(true);
      const events = (await app.inject({ method: "GET", url: "/api/events?limit=200" })).json();
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event: any) => event.provenance === "snapshot")).toBe(true);
      const detail = (await app.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
      expect(detail.evidence.every((item: any) => item.provenance === "snapshot")).toBe(true);
      const mutateDemo = await app.inject({
        method: "POST",
        url: "/api/runs",
        payload: { goal: "Must not mix real work into sample history", requirements: TEST_REQUIREMENTS },
      });
      expect(mutateDemo.statusCode).toBe(409);
      expect(mutateDemo.json().error.code).toBe("DEMO_READ_ONLY");
      await app.close();
      app = undefined;

      app = await buildApp({ databasePath, demo: false });
      await app.ready();
      expect((await app.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
        demo: true,
        dataMode: "demo",
      });
      expect((await app.inject({ method: "GET", url: "/api/runs" })).json()).toHaveLength(3);
    } finally {
      await app?.close();
      app = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes writable managed fixtures only through the explicit test-only mode", async () => {
    app = await buildApp({ databasePath: ":memory:", e2eFixture: true });
    await app.ready();
    const session = (await app.inject({ method: "GET", url: "/api/session" })).json();
    expect(session).toMatchObject({ demo: false, dataMode: "operational", permissions: { operate: true } });
    const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json();
    expect(runs).toHaveLength(3);
    expect(runs.every((run: any) => run.sourceMode === "managed")).toBe(true);
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { goal: "Exercise the writable browser fixture", requirements: TEST_REQUIREMENTS },
    });
    expect(created.statusCode).toBe(201);
  });

  it("persistently identifies legacy sample IDs as demo data", async () => {
    const db = openDatabase(":memory:");
    seedDemoData(db, { runSourceMode: "managed" });
    db.prepare("DELETE FROM settings WHERE key = 'workspace_data_mode'").run();
    app = await buildApp({ database: db, demo: false });
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
        demo: true,
        dataMode: "demo",
      });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'workspace_data_mode'").get()).toEqual({ value: "demo" });
    } finally {
      await app.close();
      app = undefined;
      db.close();
    }
  });

  it("refuses to relabel an unmarked database containing operational runs as demo", async () => {
    const db = openDatabase(":memory:");
    try {
      app = await buildApp({ database: db, demo: false, enableTestAuthHeaders: true });
      await app.ready();
      const created = await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: OPERATOR,
        payload: { goal: "Preserve a real local run", requirements: TEST_REQUIREMENTS },
      });
      expect(created.statusCode).toBe(201);
      await app.close();
      app = undefined;

      db.prepare("DELETE FROM settings WHERE key = 'workspace_data_mode'").run();
      await expect(buildApp({ database: db, demo: true })).rejects.toThrow(
        "Refusing to label a database with existing operational runs as demo",
      );
      expect(db.prepare("SELECT value FROM settings WHERE key = 'workspace_data_mode'").get()).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    } finally {
      await app?.close();
      app = undefined;
      db.close();
    }
  });

  it("ignores caller-supplied role headers unless test auth is explicitly enabled", async () => {
    app = await buildApp({ databasePath: ":memory:", demo: true, demoRunSourceMode: "managed" });
    await app.ready();
    const session = await app.inject({ method: "GET", url: "/api/session", headers: VIEWER });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ role: "admin", user: { id: "local-user" } });
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: VIEWER,
      payload: { goal: "Header role cannot downgrade or impersonate the local identity", requirements: TEST_REQUIREMENTS },
    });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/audit?runId=${created.json().id}` })).json()[0].actor).toBe("local-user");
  });

  it("requires a configured bearer token for non-loopback deployments", async () => {
    expect(() => assertSecureBind("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertSecureBind("::1", undefined)).not.toThrow();
    expect(() => assertSecureBind("0.0.0.0", undefined)).toThrow(/LOOP_ADMIN_TOKEN/);
    expect(() => assertSecureBind("192.168.1.20", "local-secret")).not.toThrow();

    app = await buildApp({ databasePath: ":memory:", demo: true, demoRunSourceMode: "managed", authToken: "local-secret" });
    await app.ready();
    const missing = await app.inject({ method: "GET", url: "/api/health" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("UNAUTHORIZED");
    const wrong = await app.inject({ method: "GET", url: "/api/session", headers: { authorization: "Bearer wrong" } });
    expect(wrong.statusCode).toBe(401);
    const accepted = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { authorization: "Bearer local-secret", "x-loop-role": "viewer" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ role: "admin", authMode: "bearer" });
  });

  it("returns a traceable overview and full run evidence graph", async () => {
    const api = await demoApp();
    const overviewResponse = await api.inject({ method: "GET", url: "/api/overview" });
    expect(overviewResponse.statusCode).toBe(200);
    const overview = overviewResponse.json();
    expect(overview.connection.mode).toBe("managed");
    expect(overview.counts.activeRuns).toBe(2);
    expect(overview.counts.pendingApprovals).toBe(1);
    expect(overview.metrics).toEqual({
      totalRuns: 3,
      terminalRuns: 1,
      succeededRuns: 0,
      unsuccessfulRuns: 1,
      successRatePct: 0,
    });
    expect(overview.attention.some((item: any) => item.kind === "approval")).toBe(true);

    const detailResponse = await api.inject({ method: "GET", url: "/api/runs/run-webhook" });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json();
    expect(detail.run.projectName).toBe("Webhook service");
    expect(detail.run.repositoryPath).toBe("/workspace/webhook-service");
    expect(detail.run.requirementProgress).toEqual({ total: 3, passed: 1, failed: 1, missing: 0 });
    expect(detail.stages.length).toBeGreaterThan(6);
    expect(detail.attempts).toHaveLength(2);
    expect(detail.requirements).toHaveLength(3);
    expect(detail.evidence.length).toBeGreaterThan(1);
    expect(detail.reviews[0].artifactDigest).toHaveLength(64);
    expect(detail.verifications.length).toBeGreaterThan(1);
    expect(detail.worktrees).toHaveLength(2);
    expect(detail.events.map((event: any) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(detail.audit.length).toBeGreaterThan(0);

    const viewerDetail = (await api.inject({ method: "GET", url: "/api/runs/run-release", headers: VIEWER })).json();
    expect(viewerDetail.artifacts.find((artifact: any) => artifact.sensitivity === "restricted").uri).toBe("[restricted]");
  });

  it("creates an arbitrary development run with defaults and signed requirements", async () => {
    const api = await demoApp();
    const response = await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: {
        projectName: "Search API",
        repositoryPath: "/work/search-api",
        runtime: "Codex CLI",
        model: "configured by runner",
        goal: "Add cursor pagination without changing existing response semantics",
        requirements: [{
          title: "Stable ordering",
          description: "Concurrent inserts must not duplicate records between pages.",
          acceptanceCriteria: "An integration test paginates while inserting and observes every original record once.",
        }],
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created.loopId).toBe("general-development");
    expect(created.status).toBe("queued");
    expect(created.requirementProgress.total).toBe(1);

    const detail = (await api.inject({ method: "GET", url: `/api/runs/${created.id}` })).json();
    expect(detail.stages.map((stage: any) => stage.key)).toEqual([
      "trigger", "intake", "state", "budget", "worktree", "maker", "verify", "checker", "human", "apply", "final-verify", "persist",
    ]);
    expect(detail.requirements[0]).toMatchObject({ revision: 1, status: "pending", title: "Stable ordering" });
    expect(detail.requirements[0].contentHash).toMatch(/^[a-f0-9]{64}$/);

    const forbidden = await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: VIEWER,
      payload: { goal: "Viewer must not create this" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    const snapshot = (await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Import historical state", sourceMode: "snapshot" },
    })).json();
    const mutateSnapshot = await api.inject({
      method: "POST",
      url: `/api/runs/${snapshot.id}/actions`,
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "queued" },
    });
    expect(mutateSnapshot.statusCode).toBe(409);
    expect(mutateSnapshot.json().error.code).toBe("SNAPSHOT_READ_ONLY");
  });

  it("enforces active-run, ordered-stage, and single-open-stage invariants", async () => {
    const api = await freshApp();
    const run = (await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Exercise the ordered stage state machine", requirements: TEST_REQUIREMENTS },
    })).json();
    let detail = (await api.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    const [trigger, intake, , , , maker] = detail.stages;

    const queuedActivation = await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${trigger.id}`,
      headers: OPERATOR,
      payload: { status: "active" },
    });
    expect(queuedActivation.statusCode).toBe(409);
    expect(queuedActivation.json().error.code).toBe("RUN_NOT_ACTIVE");

    await api.inject({
      method: "POST",
      url: `/api/runs/${run.id}/actions`,
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "queued" },
    });
    const outOfOrder = await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${maker.id}`,
      headers: OPERATOR,
      payload: { status: "active" },
    });
    expect(outOfOrder.statusCode).toBe(409);
    expect(outOfOrder.json().error.code).toBe("STAGE_ORDER");

    expect((await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${trigger.id}`,
      headers: OPERATOR,
      payload: { status: "active" },
    })).statusCode).toBe(200);
    const parallelActivation = await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${intake.id}`,
      headers: OPERATOR,
      payload: { status: "active" },
    });
    expect(parallelActivation.statusCode).toBe(409);
    expect(parallelActivation.json().error.code).toBe("STAGE_ORDER");

    expect((await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${trigger.id}`,
      headers: OPERATOR,
      payload: { status: "passed" },
    })).statusCode).toBe(200);
    detail = (await api.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
    expect(detail.run.currentStageId).toBeNull();

    await api.inject({
      method: "POST",
      url: `/api/runs/${run.id}/actions`,
      headers: OPERATOR,
      payload: { action: "pause", reason: "Verify paused-stage protection", expectedStatus: "running" },
    });
    const pausedActivation = await api.inject({
      method: "PATCH",
      url: `/api/runs/${run.id}/stages/${intake.id}`,
      headers: OPERATOR,
      payload: { status: "active" },
    });
    expect(pausedActivation.statusCode).toBe(409);
    expect(pausedActivation.json().error.code).toBe("RUN_NOT_ACTIVE");
  });

  it("ingests a complete structured runtime lifecycle without seed data", async () => {
    const api = await freshApp();
    const createdResponse = await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: {
        goal: "Implement a digest-bound local feature",
        requirements: [{
          title: "The feature works",
          description: "The new behavior must be deterministic.",
          acceptanceCriteria: "The integration command exits successfully against the candidate digest.",
        }],
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const runId = createdResponse.json().id as string;
    expect((await api.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "queued" },
    })).statusCode).toBe(200);

    let detail = (await api.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    const makerStage = detail.stages.find((stage: any) => stage.role === "maker");
    const humanStage = detail.stages.find((stage: any) => stage.role === "human");
    const requirement = detail.requirements[0];
    await activateStageInOrder(api, runId, makerStage.id);

    const fact = (payload: Record<string, unknown>) => api.inject({
      method: "POST",
      url: `/api/runs/${runId}/runtime-facts`,
      headers: OPERATOR,
      payload,
    });
    expect((await fact({
      id: "fact-fresh-maker-heartbeat",
      type: "agent.heartbeat",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      name: "Fresh maker",
      role: "maker",
      runtime: "integration-test",
      model: "test-model",
      status: "running",
      currentAction: "Starting bounded attempt",
    })).statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-checker-heartbeat",
      type: "agent.heartbeat",
      agentId: "fresh-checker",
      sessionId: "fresh-checker-session",
      name: "Fresh checker",
      role: "checker",
      runtime: "integration-test",
      model: "test-model",
      status: "waiting",
    })).statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-attempt",
      type: "attempt.started",
      attemptId: "fresh-attempt",
      stageId: makerStage.id,
      makerAgentId: "fresh-maker",
      makerSessionId: "fresh-maker-session",
    })).statusCode).toBe(201);

    const worktreeCreate = await fact({
      id: "fact-fresh-worktree-create",
      type: "worktree.recorded",
      worktreeId: "fresh-worktree",
      attemptId: "fresh-attempt",
      makerAgentId: "fresh-maker",
      makerSessionId: "fresh-maker-session",
      path: "/tmp/fresh-worktree",
      branch: "loop/fresh-attempt",
      dirty: true,
      status: "active",
      expectedVersion: 0,
    });
    expect(worktreeCreate.statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-worktree-update",
      type: "worktree.recorded",
      worktreeId: "fresh-worktree",
      attemptId: "fresh-attempt",
      makerAgentId: "fresh-maker",
      makerSessionId: "fresh-maker-session",
      path: "/tmp/fresh-worktree",
      branch: "loop/fresh-attempt",
      commit: "abc123",
      dirty: false,
      status: "active",
      expectedVersion: 1,
    })).statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-digest",
      type: "attempt.artifact",
      attemptId: "fresh-attempt",
      makerAgentId: "fresh-maker",
      makerSessionId: "fresh-maker-session",
      artifactDigest: SHA_B,
      expectedArtifactDigest: null,
    })).statusCode).toBe(201);

    const wrongDigest = await fact({
      id: "fact-fresh-wrong-digest",
      type: "verification.recorded",
      verificationId: "fresh-wrong-verification",
      attemptId: "fresh-attempt",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      name: "Wrong candidate test",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      artifactDigest: "a".repeat(64),
    });
    expect(wrongDigest.statusCode).toBe(422);
    expect(wrongDigest.json().error.code).toBe("ARTIFACT_DIGEST_MISMATCH");

    expect((await fact({
      id: "fact-fresh-artifact",
      type: "artifact.recorded",
      artifactId: "fresh-artifact",
      attemptId: "fresh-attempt",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      name: "candidate.patch",
      kind: "diff",
      uri: "artifact://fresh/candidate.patch",
      digest: SHA_B,
      sizeBytes: 412,
      verificationStatus: "verified",
      sensitivity: "internal",
    })).statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-verification",
      type: "verification.recorded",
      verificationId: "fresh-verification",
      attemptId: "fresh-attempt",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      name: "Integration suite",
      command: "npm test",
      status: "passed",
      exitCode: 0,
      durationMs: 27,
      evidenceDigest: "c".repeat(64),
      artifactDigest: SHA_B,
      outputPreview: "1 test passed",
    })).statusCode).toBe(201);
    expect((await fact({
      id: "fact-fresh-evidence",
      type: "requirement.evidence",
      evidenceId: "fresh-evidence",
      requirementId: requirement.id,
      attemptId: "fresh-attempt",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      kind: "test",
      status: "pass",
      summary: "Integration suite passed",
      command: "npm test",
      exitCode: 0,
      artifactDigest: SHA_B,
    })).statusCode).toBe(201);

    const otherRun = (await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Cross-run reference target", requirements: TEST_REQUIREMENTS },
    })).json();
    await api.inject({
      method: "POST",
      url: `/api/runs/${otherRun.id}/actions`,
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "queued" },
    });
    const crossRun = await api.inject({
      method: "POST",
      url: `/api/runs/${otherRun.id}/runtime-facts`,
      headers: OPERATOR,
      payload: {
        id: "fact-fresh-cross-run",
        type: "artifact.recorded",
        artifactId: "cross-run-artifact",
        attemptId: "fresh-attempt",
        agentId: "fresh-maker",
        sessionId: "fresh-maker-session",
        name: "invalid.patch",
        kind: "diff",
        uri: "artifact://invalid",
        digest: SHA_B,
        sizeBytes: 1,
        verificationStatus: "unverified",
        sensitivity: "internal",
      },
    });
    expect(crossRun.statusCode).toBe(422);
    expect(crossRun.json().error.code).toBe("INVALID_REFERENCE");

    expect((await fact({
      id: "fact-fresh-agent-prose",
      type: "requirement.evidence",
      evidenceId: "fresh-agent-prose",
      requirementId: requirement.id,
      attemptId: "fresh-attempt",
      agentId: "fresh-maker",
      sessionId: "fresh-maker-session",
      kind: "other",
      status: "pass",
      summary: "The maker states that the requirement is complete",
      artifactDigest: SHA_B,
      provenance: "agent_reported",
    })).statusCode).toBe(201);
    const proseOnlyVerdict = await api.inject({
      method: "POST",
      url: `/api/runs/${runId}/checker-verdicts`,
      headers: OPERATOR,
      payload: {
        attemptId: "fresh-attempt",
        checkerAgentId: "fresh-checker",
        checkerSessionId: "fresh-checker-session",
        verdict: "approve",
        summary: "Maker prose alone must not be sufficient",
        artifactDigest: SHA_B,
        requirementResults: [{
          requirementId: requirement.id,
          status: "pass",
          evidenceIds: ["fresh-agent-prose"],
          note: "No deterministic command attached",
        }],
      },
    });
    expect(proseOnlyVerdict.statusCode).toBe(422);
    expect(proseOnlyVerdict.json().error.code).toBe("DETERMINISTIC_EVIDENCE_REQUIRED");

    const verdict = await api.inject({
      method: "POST",
      url: `/api/runs/${runId}/checker-verdicts`,
      headers: OPERATOR,
      payload: {
        attemptId: "fresh-attempt",
        checkerAgentId: "fresh-checker",
        checkerSessionId: "fresh-checker-session",
        verdict: "approve",
        summary: "The current candidate satisfies the signed requirement",
        artifactDigest: SHA_B,
        requirementResults: [{
          requirementId: requirement.id,
          status: "pass",
          evidenceIds: ["fresh-evidence"],
          note: "Digest-bound integration evidence passed",
        }],
      },
    });
    expect(verdict.statusCode).toBe(201);

    expect((await api.inject({
      method: "PATCH",
      url: `/api/runs/${runId}/stages/${makerStage.id}`,
      headers: OPERATOR,
      payload: { status: "passed" },
    })).statusCode).toBe(200);
    await activateStageInOrder(api, runId, humanStage.id);

    const approvalPayload = {
      id: "fact-fresh-approval",
      type: "approval.requested",
      approvalId: "fresh-approval",
      stageId: humanStage.id,
      attemptId: "fresh-attempt",
      requestedByAgentId: "fresh-maker",
      requestedBySessionId: "fresh-maker-session",
      requestedAction: "Apply candidate",
      target: "local working tree",
      risk: "medium",
      evidenceDigest: SHA_B,
      makerSummary: "Candidate and deterministic checks are ready",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const requested = await fact(approvalPayload);
    expect(requested.statusCode).toBe(201);
    const repeated = await fact(approvalPayload);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ idempotent: true, eventId: requested.json().eventId });
    const conflictingFact = await fact({ ...approvalPayload, requestedAction: "Publish candidate" });
    expect(conflictingFact.statusCode).toBe(409);
    expect(conflictingFact.json().error.code).toBe("FACT_ID_CONFLICT");

    const approved = await api.inject({
      method: "POST",
      url: "/api/approvals/fresh-approval/decision",
      headers: OPERATOR,
      payload: { decision: "approved", reason: "Local owner reviewed the evidence", expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    const incompleteStages = await api.inject({
      method: "PATCH",
      url: `/api/runs/${runId}/status`,
      headers: OPERATOR,
      payload: { status: "succeeded", expectedStatus: "running" },
    });
    expect(incompleteStages.statusCode).toBe(422);
    expect(incompleteStages.json().error.message).toContain("stages remain incomplete");

    detail = (await api.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    for (const stage of detail.stages) {
      let status = stage.status;
      if (status === "pending") {
        const activated = await api.inject({
          method: "PATCH",
          url: `/api/runs/${runId}/stages/${stage.id}`,
          headers: OPERATOR,
          payload: { status: "active" },
        });
        expect(activated.statusCode).toBe(200);
        status = "active";
      }
      if (status === "active" || status === "waiting") {
        expect((await api.inject({
          method: "PATCH",
          url: `/api/runs/${runId}/stages/${stage.id}`,
          headers: OPERATOR,
          payload: { status: "passed" },
        })).statusCode).toBe(200);
      }
    }
    const completed = await api.inject({
      method: "PATCH",
      url: `/api/runs/${runId}/status`,
      headers: OPERATOR,
      payload: { status: "succeeded", expectedStatus: "running" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("succeeded");

    detail = (await api.inject({ method: "GET", url: `/api/runs/${runId}` })).json();
    expect(detail).toMatchObject({
      attempts: [{ id: "fresh-attempt", status: "success", artifactDigest: SHA_B }],
      verifications: [{ id: "fresh-verification", status: "passed" }],
      approvals: [{ id: "fresh-approval", status: "approved", evidenceDigest: SHA_B }],
      artifacts: [{ id: "fresh-artifact", digest: SHA_B }],
      worktrees: [{ id: "fresh-worktree", commit: "abc123", dirty: false }],
    });
    expect(detail.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fresh-evidence", status: "pass", artifactDigest: SHA_B }),
    ]));
    expect(detail.events.some((event: any) => event.type === "approval.requested")).toBe(true);
    expect(detail.audit.some((entry: any) => entry.action === "runtime_fact.requirement.evidence")).toBe(true);
  });

  it("marks missed heartbeats stale, accepts recovery, and records failed attempt completion", async () => {
    const db = openDatabase(":memory:");
    app = await buildApp({ database: db, demo: false, demoRunSourceMode: "managed", enableTestAuthHeaders: true });
    await app.ready();
    try {
      const api = app;
      const run = (await api.inject({
        method: "POST",
        url: "/api/runs",
        headers: OPERATOR,
        payload: { goal: "Observe a failed bounded attempt", requirements: TEST_REQUIREMENTS },
      })).json();
      await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/actions`,
        headers: OPERATOR,
        payload: { action: "start", expectedStatus: "queued" },
      });
      const runDetail = (await api.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
      const makerStage = runDetail.stages.find((stage: any) => stage.role === "maker");
      await activateStageInOrder(api, run.id, makerStage.id);
      const heartbeat = {
        type: "agent.heartbeat",
        agentId: "failure-maker",
        sessionId: "failure-maker-session",
        name: "Failure maker",
        role: "maker",
        runtime: "integration-test",
        model: "test-model",
        status: "running",
      };
      await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/runtime-facts`,
        headers: OPERATOR,
        payload: { id: "fact-failure-heartbeat-1", ...heartbeat },
      });
      db.prepare("UPDATE agents SET last_heartbeat_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 6 * 60_000).toISOString(), "failure-maker");
      expect((await api.inject({ method: "GET", url: "/api/agents" })).json()[0].status).toBe("stale");
      expect((await api.inject({ method: "GET", url: "/api/overview" })).json().counts.staleAgents).toBe(1);
      const attemptPayload = {
        id: "fact-failure-attempt",
        type: "attempt.started",
        attemptId: "failure-attempt",
        stageId: makerStage.id,
        makerAgentId: "failure-maker",
        makerSessionId: "failure-maker-session",
      };
      const staleAttempt = await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/runtime-facts`,
        headers: OPERATOR,
        payload: attemptPayload,
      });
      expect(staleAttempt.statusCode).toBe(422);
      expect(staleAttempt.json().error.code).toBe("AGENT_NOT_ACTIVE");

      const recovered = await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/runtime-facts`,
        headers: OPERATOR,
        payload: { id: "fact-failure-heartbeat-2", ...heartbeat, currentAction: "Retrying after reconnect" },
      });
      expect(recovered.statusCode).toBe(201);
      expect((await api.inject({ method: "GET", url: "/api/agents" })).json()[0].status).toBe("running");

      await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/runtime-facts`,
        headers: OPERATOR,
        payload: attemptPayload,
      });
      const failed = await api.inject({
        method: "POST",
        url: `/api/runs/${run.id}/runtime-facts`,
        headers: OPERATOR,
        payload: {
          id: "fact-failure-finished",
          type: "attempt.finished",
          attemptId: "failure-attempt",
          makerAgentId: "failure-maker",
          makerSessionId: "failure-maker-session",
          status: "failure",
          summary: "Deterministic command failed",
          errorSignature: "TEST_FAILURE",
          expectedStatus: "running",
        },
      });
      expect(failed.statusCode).toBe(201);
      const failedDetail = (await api.inject({ method: "GET", url: `/api/runs/${run.id}` })).json();
      expect(failedDetail.attempts[0].status).toBe("failure");
      expect(failedDetail.events.at(-1)).toMatchObject({ type: "attempt.failed", payload: { errorSignature: "TEST_FAILURE" } });
      expect(failedDetail.run.breaker.consecutiveFailures).toBe(1);
    } finally {
      await app.close();
      app = undefined;
      db.close();
    }
  });

  it("enforces reasons, compare-and-swap transitions, terminal rules and immutable retry history", async () => {
    const api = await demoApp();
    const missingReason = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "pause", expectedStatus: "running" },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(missingReason.json().error.code).toBe("REASON_REQUIRED");

    const paused = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "pause", reason: "Inspect a flaky external fixture", expectedStatus: "running" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("paused");

    const stale = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Fixture is stable", expectedStatus: "running" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_RUN");

    const terminal = await api.inject({
      method: "POST",
      url: "/api/runs/run-deps/actions",
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "capped" },
    });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json().error.code).toBe("TERMINAL_RUN");

    const retried = await api.inject({
      method: "POST",
      url: "/api/runs/run-deps/actions",
      headers: OPERATOR,
      payload: { action: "retry", reason: "Try a maintainer-approved compatible version", expectedStatus: "capped" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: "queued", projectName: "Platform SDK" });
    expect(retried.json().id).not.toBe("run-deps");
    const oldRun = (await api.inject({ method: "GET", url: "/api/runs/run-deps" })).json();
    expect(oldRun.run.status).toBe("capped");
    expect(oldRun.attempts).toHaveLength(3);
    const newRun = (await api.inject({ method: "GET", url: `/api/runs/${retried.json().id}` })).json();
    expect(newRun.attempts).toHaveLength(0);
    expect(newRun.requirements).toHaveLength(1);
    expect(newRun.requirements[0].status).toBe("pending");
  });

  it("atomically reconciles child state and revokes approvals when a run terminates", async () => {
    const api = await demoApp();
    const cancelled = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "cancel", reason: "Stop the local execution", expectedStatus: "running" },
    });
    expect(cancelled.statusCode).toBe(200);
    const cancelledDetail = (await api.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
    expect(cancelledDetail.run).toMatchObject({ status: "cancelled", currentStageId: null });
    expect(cancelledDetail.attempts.find((attempt: any) => attempt.id === "attempt-webhook-2").status).toBe("cancelled");
    expect(cancelledDetail.agents.filter((agent: any) => agent.status === "running" || agent.status === "waiting")).toHaveLength(0);
    expect(cancelledDetail.stages.filter((stage: any) => ["active", "waiting", "blocked", "pending"].includes(stage.status)))
      .toHaveLength(0);
    expect(cancelledDetail.worktrees.find((worktree: any) => worktree.id === "worktree-webhook-2").status).toBe("stale");

    const cancelledRelease = await api.inject({
      method: "POST",
      url: "/api/runs/run-release/actions",
      headers: OPERATOR,
      payload: { action: "cancel", reason: "Withdraw the release", expectedStatus: "waiting" },
    });
    expect(cancelledRelease.statusCode).toBe(200);
    const releaseDetail = (await api.inject({ method: "GET", url: "/api/runs/run-release" })).json();
    expect(releaseDetail.approvals[0]).toMatchObject({ status: "revoked", decidedBy: "test-operator" });
    const lateDecision = await api.inject({
      method: "PATCH",
      url: "/api/approvals/approval-release/decision",
      headers: OPERATOR,
      payload: { decision: "approved", reason: "Too late", expectedVersion: 2 },
    });
    expect(lateDecision.statusCode).toBe(409);
    expect(lateDecision.json().error.code).toBe("TERMINAL_RUN");
  });

  it("rejects terminal and same-state mutations without changing versions, timestamps, or events", async () => {
    const db = openDatabase(":memory:");
    seedDemoData(db, { runSourceMode: "managed" });
    app = await buildApp({ database: db, demo: false, demoRunSourceMode: "managed", enableTestAuthHeaders: true });
    await app.ready();
    try {
      const terminalRunBefore = db.prepare(`SELECT status, finished_at, updated_at, version, last_sequence
        FROM runs WHERE id = 'run-deps'`).get();
      const terminalStageBefore = db.prepare(`SELECT status, started_at, finished_at, version
        FROM stages WHERE id = 'stage-deps-checker'`).get();
      const terminalEventCountBefore = db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-deps'").get();

      const terminalRewrite = await app.inject({
        method: "PATCH",
        url: "/api/runs/run-deps/status",
        headers: OPERATOR,
        payload: { status: "capped", reason: "Must not rewrite completion", expectedStatus: "capped" },
      });
      expect(terminalRewrite.statusCode).toBe(409);
      expect(terminalRewrite.json().error.code).toBe("TERMINAL_RUN");

      const terminalAction = await app.inject({
        method: "POST",
        url: "/api/runs/run-deps/actions",
        headers: OPERATOR,
        payload: { action: "cancel", reason: "Must not rewrite completion", expectedStatus: "capped" },
      });
      expect(terminalAction.statusCode).toBe(409);
      expect(terminalAction.json().error.code).toBe("TERMINAL_RUN");

      const stageUnderTerminalRun = await app.inject({
        method: "PATCH",
        url: "/api/runs/run-deps/stages/stage-deps-checker",
        headers: OPERATOR,
        payload: { status: "failed" },
      });
      expect(stageUnderTerminalRun.statusCode).toBe(409);
      expect(stageUnderTerminalRun.json().error.code).toBe("TERMINAL_RUN");
      expect(db.prepare(`SELECT status, finished_at, updated_at, version, last_sequence
        FROM runs WHERE id = 'run-deps'`).get()).toEqual(terminalRunBefore);
      expect(db.prepare(`SELECT status, started_at, finished_at, version
        FROM stages WHERE id = 'stage-deps-checker'`).get()).toEqual(terminalStageBefore);
      expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-deps'").get()).toEqual(terminalEventCountBefore);

      const activeRunBefore = db.prepare(`SELECT status, finished_at, updated_at, version, last_sequence
        FROM runs WHERE id = 'run-webhook'`).get();
      const activeEventCountBefore = db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-webhook'").get();
      const sameAction = await app.inject({
        method: "POST",
        url: "/api/runs/run-webhook/actions",
        headers: OPERATOR,
        payload: { action: "start", expectedStatus: "running" },
      });
      expect(sameAction.statusCode).toBe(409);
      expect(sameAction.json().error.code).toBe("INVALID_TRANSITION");
      expect(db.prepare(`SELECT status, finished_at, updated_at, version, last_sequence
        FROM runs WHERE id = 'run-webhook'`).get()).toEqual(activeRunBefore);

      const passedStageBefore = db.prepare(`SELECT status, started_at, finished_at, duration_ms, version
        FROM stages WHERE id = 'stage-webhook-trigger'`).get();
      const passedStageRewrite = await app.inject({
        method: "PATCH",
        url: "/api/runs/run-webhook/stages/stage-webhook-trigger",
        headers: OPERATOR,
        payload: { status: "passed" },
      });
      expect(passedStageRewrite.statusCode).toBe(409);
      expect(passedStageRewrite.json().error.code).toBe("TERMINAL_STAGE");
      expect(db.prepare(`SELECT status, started_at, finished_at, duration_ms, version
        FROM stages WHERE id = 'stage-webhook-trigger'`).get()).toEqual(passedStageBefore);
      expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-webhook'").get()).toEqual(activeEventCountBefore);
    } finally {
      await app.close();
      app = undefined;
      db.close();
    }
  });

  it.each(["failure", "noop", "cancelled"] as const)(
    "rejects checker verdicts for maker-finished %s attempts without side effects",
    async (attemptStatus) => {
      const db = openDatabase(":memory:");
      seedDemoData(db, { runSourceMode: "managed" });
      app = await buildApp({ database: db, demo: false, demoRunSourceMode: "managed", enableTestAuthHeaders: true });
      await app.ready();
      try {
        const frozenFinishedAt = "2026-07-15T01:02:03.000Z";
        db.prepare(`UPDATE attempts SET status = ?, finished_at = ?, checker_agent_id = NULL,
          checker_session_id = NULL, checker_status = 'pending', checker_summary = NULL, version = 41
          WHERE id = 'attempt-webhook-2'`).run(attemptStatus, frozenFinishedAt);
        const attemptBefore = db.prepare(`SELECT status, finished_at, checker_agent_id, checker_session_id,
          checker_status, checker_summary, version FROM attempts WHERE id = 'attempt-webhook-2'`).get();
        const eventCountBefore = db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-webhook'").get();

        const verdict = await app.inject({
          method: "POST",
          url: "/api/runs/run-webhook/checker-verdicts",
          headers: OPERATOR,
          payload: {
            attemptId: "attempt-webhook-2",
            checkerAgentId: "agent-checker",
            checkerSessionId: "session-checker-002",
            verdict: "reject",
            summary: "A completed maker attempt cannot be reclassified by a later checker",
            artifactDigest: SHA_B,
          },
        });
        expect(verdict.statusCode).toBe(409);
        expect(verdict.json().error.code).toBe("ATTEMPT_NOT_RUNNING");
        expect(db.prepare(`SELECT status, finished_at, checker_agent_id, checker_session_id,
          checker_status, checker_summary, version FROM attempts WHERE id = 'attempt-webhook-2'`).get()).toEqual(attemptBefore);
        expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = 'run-webhook'").get()).toEqual(eventCountBefore);
      } finally {
        await app.close();
        app = undefined;
        db.close();
      }
    },
  );

  it("redacts secrets before persistence and rejects duplicate or regressing events", async () => {
    const api = await demoApp();
    const event = {
      id: "74d6ce88-82d4-44b4-873a-8349e8ff9341",
      runId: "run-webhook",
      type: "tool.completed",
      severity: "info",
      message: "Request used sk-abcdefghijklmnopqrstuvwxyz123456",
      payload: { apiKey: "raw-secret", nested: { authorization: "Bearer raw-token-value-123456789" } },
      provenance: "runtime",
      actor: "spoofed-runner",
      correlationId: "trace Bearer correlation-secret-123456789",
      occurredAt: new Date().toISOString(),
    };
    const inserted = await api.inject({ method: "POST", url: "/api/events", headers: OPERATOR, payload: event });
    expect(inserted.statusCode).toBe(201);
    expect(inserted.json()).toMatchObject({ sequence: 10, redacted: true });
    expect(inserted.body).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(inserted.body).not.toContain("raw-secret");
    expect(inserted.body).not.toContain("correlation-secret-123456789");
    expect(inserted.json().payload.apiKey).toBe("[REDACTED]");
    expect(inserted.json()).toMatchObject({ actor: "test-operator", correlationId: "trace [REDACTED]" });
    const persisted = (await api.inject({ method: "GET", url: "/api/runs/run-webhook/events?after=9" })).json();
    expect(persisted[0]).toMatchObject({ actor: "test-operator", correlationId: "trace [REDACTED]", redacted: true });
    const replay = await api.inject({
      method: "GET",
      url: "/api/runs/run-webhook/events/stream?after=9&replayOnly=true",
    });
    expect(replay.body).not.toContain("correlation-secret-123456789");
    expect(replay.body).toContain('"actor":"test-operator"');
    const ingestAudit = (await api.inject({ method: "GET", url: "/api/audit?runId=run-webhook" })).json();
    expect(ingestAudit.some((entry: any) => entry.action === "event.ingest"
      && entry.actor === "test-operator" && entry.targetId === event.id)).toBe(true);

    const duplicate = await api.inject({ method: "POST", url: "/api/events", headers: OPERATOR, payload: event });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("DUPLICATE_EVENT");

    const regression = await api.inject({
      method: "POST",
      url: "/api/events",
      headers: OPERATOR,
      payload: { ...event, id: "afba0e3b-62c0-48e6-afac-af6e5a784929", sequence: 3 },
    });
    expect(regression.statusCode).toBe(409);
    expect(regression.json().error.code).toBe("SEQUENCE_REGRESSION");
  });

  it("prevents maker self-review and binds checker verdicts to the current digest", async () => {
    const api = await demoApp();
    const selfReview = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "agent-maker",
        checkerSessionId: "independent-name-but-same-agent",
        verdict: "approve",
        summary: "I approve my own work",
        artifactDigest: SHA_B,
      },
    });
    expect(selfReview.statusCode).toBe(422);
    expect(selfReview.json().error.code).toBe("CHECKER_INVARIANT");
    const rejectedAudit = (await api.inject({ method: "GET", url: "/api/audit?runId=run-webhook" })).json();
    expect(rejectedAudit.some((entry: any) => entry.action === "checker.verdict_rejected"
      && entry.actor === "test-operator" && entry.targetId === "attempt-webhook-2")).toBe(true);

    const wrongDigest = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "agent-checker",
        checkerSessionId: "session-checker-002",
        verdict: "reject",
        summary: "Evidence digest does not match",
        artifactDigest: "wrong-digest",
      },
    });
    expect(wrongDigest.statusCode).toBe(422);
    expect(wrongDigest.json().error.code).toBe("CHECKER_INVARIANT");

    const inventedChecker = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "invented-checker",
        checkerSessionId: "invented-session",
        verdict: "reject",
        summary: "Caller-invented identity must not be trusted",
        artifactDigest: SHA_B,
      },
    });
    expect(inventedChecker.statusCode).toBe(422);
    expect(inventedChecker.json().error.code).toBe("CHECKER_IDENTITY");

    const incompleteApproval = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "agent-checker",
        checkerSessionId: "session-checker-002",
        verdict: "approve",
        summary: "No requirement evidence attached",
        artifactDigest: SHA_B,
        requirementResults: [],
      },
    });
    expect(incompleteApproval.statusCode).toBe(422);
    expect(incompleteApproval.json().error.code).toBe("INCOMPLETE_REQUIREMENT_REVIEW");

    const evidenceBoundRejection = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "agent-checker",
        checkerSessionId: "session-checker-002",
        verdict: "reject",
        summary: "Concurrency and redaction requirements remain incomplete",
        artifactDigest: SHA_B,
        requirementResults: [
          { requirementId: "req-webhook-idempotency", status: "fail", evidenceIds: [], note: "Concurrency proof missing" },
          { requirementId: "req-webhook-retry", status: "pass", evidenceIds: ["evidence-webhook-unit"], note: "Retry boundaries pass" },
          { requirementId: "req-webhook-observe", status: "missing", evidenceIds: [], note: "Redaction evidence missing" },
        ],
      },
    });
    expect(evidenceBoundRejection.statusCode).toBe(201);
    expect(evidenceBoundRejection.json().requirementResults).toHaveLength(3);
    const frozenMutation = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/runtime-facts",
      headers: OPERATOR,
      payload: {
        id: "fact-frozen-attempt-mutation",
        type: "attempt.artifact",
        attemptId: "attempt-webhook-2",
        makerAgentId: "agent-maker",
        makerSessionId: "session-maker-002",
        artifactDigest: "d".repeat(64),
        expectedArtifactDigest: SHA_B,
      },
    });
    expect(frozenMutation.statusCode).toBe(409);
    expect(frozenMutation.json().error.code).toBe("ATTEMPT_IMMUTABLE");

    const retry = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/runtime-facts",
      headers: OPERATOR,
      payload: {
        id: "fact-webhook-attempt-3",
        type: "attempt.started",
        attemptId: "attempt-webhook-3",
        stageId: "stage-webhook-maker",
        makerAgentId: "agent-maker",
        makerSessionId: "session-maker-002",
        previousAttemptId: "attempt-webhook-2",
        feedbackReviewId: evidenceBoundRejection.json().id,
        feedbackSummary: "Concurrency and redaction requirements remain incomplete",
      },
    });
    expect(retry.statusCode).toBe(201);

    const detail = (await api.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
    expect(detail.attempts.find((attempt: any) => attempt.id === "attempt-webhook-2").checkerStatus).toBe("reject");
    expect(detail.attempts.find((attempt: any) => attempt.id === "attempt-webhook-2").status).toBe("rejected");
    expect(detail.attempts.find((attempt: any) => attempt.id === "attempt-webhook-3")).toMatchObject({
      number: 3,
      status: "running",
      previousAttemptId: "attempt-webhook-2",
      feedbackReviewId: evidenceBoundRejection.json().id,
      feedbackSummary: "Concurrency and redaction requirements remain incomplete",
    });
    expect(detail.attempts.find((attempt: any) => attempt.id === "attempt-webhook-2").artifactDigest).toBe(SHA_B);
    expect(detail.reviews.find((review: any) => review.id === evidenceBoundRejection.json().id)).toMatchObject({
      verdict: "reject",
      summary: "Concurrency and redaction requirements remain incomplete",
      artifactDigest: SHA_B,
    });
    expect(detail.events.some((event: any) => event.type === "checker.verdict"
      && event.attemptId === "attempt-webhook-2" && event.artifactDigest === SHA_B)).toBe(true);
    expect(detail.requirements.find((requirement: any) => requirement.id === "req-webhook-observe").status).toBe("missing");
  });

  it("uses approval versions to prevent double decisions and records the deciding identity", async () => {
    const api = await demoApp();
    const approved = await api.inject({
      method: "PATCH",
      url: "/api/approvals/approval-release/decision",
      headers: OPERATOR,
      payload: { decision: "approved", reason: "Evidence and target digest reviewed", expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", decidedBy: "test-operator", version: 2 });

    const staleDecision = await api.inject({
      method: "PATCH",
      url: "/api/approvals/approval-release/decision",
      headers: ADMIN,
      payload: { decision: "rejected", reason: "Late conflicting decision", expectedVersion: 1 },
    });
    expect(staleDecision.statusCode).toBe(409);
    expect(staleDecision.json().error.code).toBe("APPROVAL_DECIDED");
    expect(staleDecision.json().error.details.approval.decidedBy).toBe("test-operator");
  });

  it("opens the circuit breaker on repeated failure signatures and requires an audited override", async () => {
    const api = await demoApp();
    for (let index = 0; index < 3; index += 1) {
      const response = await api.inject({
        method: "POST",
        url: "/api/events",
        headers: OPERATOR,
        payload: {
          id: `00000000-0000-4000-8000-00000000010${index}`,
          runId: "run-webhook",
          type: "attempt.failed",
          severity: "error",
          message: "Concurrent delivery assertion failed",
          payload: { errorSignature: "ERR_DUPLICATE_DELIVERY" },
          provenance: "runtime",
          actor: "runner",
          occurredAt: new Date().toISOString(),
        },
      });
      expect(response.statusCode).toBe(201);
    }
    const blocked = (await api.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.breaker).toMatchObject({
      status: "open",
      sameErrorCount: 3,
      errorSignature: "ERR_DUPLICATE_DELIVERY",
    });
    expect(blocked.events.at(-1).type).toBe("breaker.opened");
    const progressWhileBroken = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/runtime-facts",
      headers: OPERATOR,
      payload: {
        id: "fact-breaker-must-stop-attempt",
        type: "attempt.started",
        attemptId: "attempt-breaker-must-not-start",
        stageId: "stage-webhook-maker",
        makerAgentId: "agent-maker",
        makerSessionId: "session-maker-002",
      },
    });
    expect(progressWhileBroken.statusCode).toBe(409);
    expect(progressWhileBroken.json().error.code).toBe("BREAKER_OPEN");
    const heartbeatWhileBroken = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/runtime-facts",
      headers: OPERATOR,
      payload: {
        id: "fact-breaker-heartbeat",
        type: "agent.heartbeat",
        agentId: "agent-maker",
        sessionId: "session-maker-002",
        name: "Maker 02",
        role: "maker",
        runtime: "Codex CLI",
        model: "gpt-5",
        status: "waiting",
        currentAction: "Stopped by open circuit breaker",
      },
    });
    expect(heartbeatWhileBroken.statusCode).toBe(201);
    const lateTerminalReport = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/runtime-facts",
      headers: OPERATOR,
      payload: {
        id: "fact-breaker-late-failure",
        type: "attempt.finished",
        attemptId: "attempt-webhook-2",
        makerAgentId: "agent-maker",
        makerSessionId: "session-maker-002",
        status: "failure",
        summary: "In-flight attempt stopped after the breaker opened",
        errorSignature: "ERR_DUPLICATE_DELIVERY",
      },
    });
    expect(lateTerminalReport.statusCode).toBe(201);
    const afterLateReport = (await api.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
    expect(afterLateReport.run.breaker.trigger).toBe(blocked.run.breaker.trigger);
    expect(afterLateReport.run.breaker.openedAt).toBe(blocked.run.breaker.openedAt);
    expect(afterLateReport.events.filter((event: any) => event.type === "breaker.opened")).toHaveLength(1);
    expect(afterLateReport.attempts.find((attempt: any) => attempt.id === "attempt-webhook-2").status).toBe("failure");
    const stageWhileBroken = await api.inject({
      method: "PATCH",
      url: "/api/runs/run-webhook/stages/stage-webhook-maker",
      headers: OPERATOR,
      payload: { status: "passed" },
    });
    expect(stageWhileBroken.statusCode).toBe(409);
    expect(stageWhileBroken.json().error.code).toBe("BREAKER_OPEN");
    const verdictWhileBroken = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/checker-verdicts",
      headers: OPERATOR,
      payload: {
        attemptId: "attempt-webhook-2",
        checkerAgentId: "agent-checker",
        checkerSessionId: "session-checker-002",
        verdict: "reject",
        summary: "Must not decide while breaker is open",
        artifactDigest: SHA_B,
      },
    });
    expect(verdictWhileBroken.statusCode).toBe(409);
    expect(verdictWhileBroken.json().error.code).toBe("BREAKER_OPEN");

    const resumeBlocked = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Try again", expectedStatus: "blocked" },
    });
    expect(resumeBlocked.statusCode).toBe(409);
    expect(resumeBlocked.json().error.code).toBe("BREAKER_OPEN");

    const override = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: ADMIN,
      payload: { action: "override_breaker", reason: "Fixture repaired; preserve prior ledger", expectedStatus: "blocked" },
    });
    expect(override.statusCode).toBe(200);
    expect(override.json().breaker.status).toBe("overridden");
    const resumed = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Fixture repair verified", expectedStatus: "blocked" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe("running");
    expect(resumed.json().breaker.sameErrorCount).toBe(4);
  });

  it("persists global pause with reason and CAS, blocking create, start and resume", async () => {
    const api = await demoApp();
    const initial = await api.inject({ method: "GET", url: "/api/settings/global-pause" });
    expect(initial.json()).toMatchObject({ paused: false, version: 1 });

    const denied = await api.inject({
      method: "PATCH",
      url: "/api/settings/global-pause",
      headers: VIEWER,
      payload: { paused: true, reason: "Viewer cannot pause", expectedVersion: 1 },
    });
    expect(denied.statusCode).toBe(403);

    const paused = await api.inject({
      method: "PATCH",
      url: "/api/settings/global-pause",
      headers: OPERATOR,
      payload: { paused: true, reason: "Investigate runaway external calls", expectedVersion: 1 },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ paused: true, version: 2, changedBy: "test-operator" });
    expect((await api.inject({ method: "GET", url: "/api/overview" })).json().connection.globalPause).toBe(true);

    const stale = await api.inject({
      method: "PATCH",
      url: "/api/settings/global-pause",
      headers: ADMIN,
      payload: { paused: false, reason: "Stale decision", expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_GLOBAL_PAUSE");

    const createBlocked = await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Must not start while paused", requirements: TEST_REQUIREMENTS },
    });
    expect(createBlocked.statusCode).toBe(409);
    expect(createBlocked.json().error.code).toBe("GLOBAL_PAUSE");

    await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "pause", reason: "Honor workspace pause", expectedStatus: "running" },
    });
    const resumeBlocked = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Attempted too early", expectedStatus: "paused" },
    });
    expect(resumeBlocked.statusCode).toBe(409);
    expect(resumeBlocked.json().error.code).toBe("GLOBAL_PAUSE");

    const unpaused = await api.inject({
      method: "PATCH",
      url: "/api/settings/global-pause",
      headers: ADMIN,
      payload: { paused: false, reason: "External calls isolated", expectedVersion: 2 },
    });
    expect(unpaused.json()).toMatchObject({ paused: false, version: 3 });
    const resumed = await api.inject({
      method: "POST",
      url: "/api/runs/run-webhook/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Workspace resumed", expectedStatus: "paused" },
    });
    expect(resumed.statusCode).toBe(200);
    const audit = (await api.inject({ method: "GET", url: "/api/audit" })).json();
    expect(audit.some((item: any) => item.action === "workspace.pause" && item.reason.includes("runaway"))).toBe(true);
    expect(audit.some((item: any) => item.action === "workspace.resume")).toBe(true);
  });

  it("turns exhausted cumulative usage into a capped terminal run", async () => {
    const api = await demoApp();
    const created = (await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Perform bounded repository analysis", requirements: TEST_REQUIREMENTS },
    })).json();
    await api.inject({
      method: "POST",
      url: `/api/runs/${created.id}/actions`,
      headers: OPERATOR,
      payload: { action: "start", expectedStatus: "queued" },
    });
    const usage = await api.inject({
      method: "POST",
      url: "/api/events",
      headers: OPERATOR,
      payload: {
        id: "00000000-0000-4000-8000-000000000201",
        runId: created.id,
        type: "budget.updated",
        severity: "info",
        message: "Cumulative usage checkpoint",
        payload: { tokensUsed: 120_000, costUsedUsd: 3.2, iterationsUsed: 4 },
        provenance: "runtime",
        actor: "runner",
        occurredAt: new Date().toISOString(),
      },
    });
    expect(usage.statusCode).toBe(201);
    const detail = (await api.inject({ method: "GET", url: `/api/runs/${created.id}` })).json();
    expect(detail.run).toMatchObject({ status: "capped", finishedAt: expect.any(String) });
    expect(detail.run.budget).toMatchObject({ tokensUsed: 120_000, costUsedUsd: 3.2, iterationsUsed: 4 });
    expect(detail.run.breaker.status).toBe("open");
    expect(detail.events.at(-1).type).toBe("budget.exhausted");
  });

  it("rejects uncompletable managed runs and permits completion only with current review evidence", async () => {
    const api = await demoApp();
    const unsupported = await api.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "A run with no signed requirements cannot be called done" },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe("VALIDATION_ERROR");
    expect(unsupported.json().error.details[0]).toMatchObject({ path: ["requirements"] });

    await api.inject({
      method: "PATCH",
      url: "/api/approvals/approval-release/decision",
      headers: OPERATOR,
      payload: { decision: "approved", reason: "Release evidence reviewed", expectedVersion: 1 },
    });
    const resumed = await api.inject({
      method: "POST",
      url: "/api/runs/run-release/actions",
      headers: OPERATOR,
      payload: { action: "resume", reason: "Publish gate approved", expectedStatus: "waiting" },
    });
    expect(resumed.statusCode).toBe(200);
    expect((await api.inject({
      method: "PATCH",
      url: "/api/runs/run-release/stages/stage-release-human",
      headers: OPERATOR,
      payload: { status: "passed" },
    })).statusCode).toBe(200);
    expect((await api.inject({
      method: "PATCH",
      url: "/api/runs/run-release/stages/stage-release-persist",
      headers: OPERATOR,
      payload: { status: "active" },
    })).statusCode).toBe(200);
    expect((await api.inject({
      method: "PATCH",
      url: "/api/runs/run-release/stages/stage-release-persist",
      headers: OPERATOR,
      payload: { status: "passed" },
    })).statusCode).toBe(200);
    const completed = await api.inject({
      method: "PATCH",
      url: "/api/runs/run-release/status",
      headers: OPERATOR,
      payload: { status: "succeeded", expectedStatus: "running" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("succeeded");
  });

  it("replays SSE from Last-Event-ID without duplicates and reports impossible cursors", async () => {
    const api = await demoApp();
    const replay = await api.inject({
      method: "GET",
      url: "/api/runs/run-webhook/events/stream?replayOnly=true",
      headers: { "last-event-id": "7" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    expect(replay.body).toContain("id: 8");
    expect(replay.body).toContain("id: 9");
    expect(replay.body).not.toContain("id: 7\n");

    const gap = await api.inject({
      method: "GET",
      url: "/api/runs/run-webhook/events/stream?replayOnly=1",
      headers: { "last-event-id": "99" },
    });
    expect(gap.statusCode).toBe(200);
    expect(gap.body).toContain("event: stream-gap");
    expect(gap.body).toContain('"availableThrough":9');
    expect(gap.body).toContain('"resetTo":9');
  });

  it("replays more than 2,000 queued SSE events without dropping a page", async () => {
    const db = openDatabase(":memory:");
    seedDemoData(db, { runSourceMode: "managed" });
    const timestamp = new Date().toISOString();
    transaction(db, () => {
      const insert = db.prepare(`INSERT INTO events(id, run_id, sequence, stage_id, attempt_id, type, severity,
        message, payload_json, provenance, actor, correlation_id, artifact_digest, redacted, occurred_at, received_at)
        VALUES (?, 'run-webhook', ?, NULL, NULL, 'bulk.test', 'debug', ?, '{}', 'runtime', 'load-test', NULL, NULL, 0, ?, ?)`);
      for (let sequence = 10; sequence <= 2_014; sequence += 1) {
        insert.run(`bulk-event-${sequence}`, sequence, `Queued event ${sequence}`, timestamp, timestamp);
      }
      db.prepare("UPDATE runs SET last_sequence = 2014, last_event_at = ?, updated_at = ? WHERE id = 'run-webhook'")
        .run(timestamp, timestamp);
    });
    app = await buildApp({ database: db });
    await app.ready();
    try {
      const detail = (await app.inject({ method: "GET", url: "/api/runs/run-webhook" })).json();
      expect(detail.events).toHaveLength(500);
      expect(detail.events[0].sequence).toBe(1_515);
      expect(detail.events.at(-1).sequence).toBe(2_014);

      const page = (await app.inject({
        method: "GET",
        url: "/api/runs/run-webhook/events/page?after=2009&limit=3",
      })).json();
      expect(page.items.map((event: any) => event.sequence)).toEqual([2_010, 2_011, 2_012]);
      expect(page.page).toEqual({
        after: 2_009,
        nextAfter: 2_012,
        limit: 3,
        hasMore: true,
        availableFrom: 1,
        availableThrough: 2_014,
      });

      const replay = await app.inject({
        method: "GET",
        url: "/api/runs/run-webhook/events/stream?replayOnly=true",
        headers: { "last-event-id": "9" },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.body.match(/event: loop-event/g)).toHaveLength(2_005);
      expect(replay.body).toContain("id: 2014\n");
      const queryCursorReplay = await app.inject({
        method: "GET",
        url: "/api/runs/run-webhook/events/stream?after=2010&replayOnly=true",
      });
      expect(queryCursorReplay.body.match(/event: loop-event/g)).toHaveLength(4);
      expect(queryCursorReplay.body).not.toContain("id: 2010\n");
      expect(queryCursorReplay.body).toContain("id: 2014\n");
    } finally {
      await app.close();
      app = undefined;
      db.close();
    }
  });
});
