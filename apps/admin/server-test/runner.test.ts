// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server/app.js";

const runner = fileURLToPath(new URL("../../../scripts/loop-admin-run.mjs", import.meta.url));
const OPERATOR = { "x-loop-role": "operator", "x-loop-actor": "runner-test" };
const REQUIREMENTS = [{
  title: "Command verification",
  description: "The configured local command must execute against the candidate.",
  acceptanceCriteria: "A digest-bound command result exits successfully and an independent checker reviews it.",
}];

describe("loop-admin-run", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([0, 7])("runs the command and preserves exit code %i when Admin is unavailable", async (expectedCode) => {
    const result = await runWithUnavailableAdmin(expectedCode);

    expect(result.code).toBe(expectedCode);
    expect(result.stdout).toContain(`command-ran-${expectedCode}`);
    expect(result.stderr).toContain("loop-admin telemetry warning:");
  });

  it("drives a successful command to a digest-bound independent-checker gate", async () => {
    const managed = await createManagedRun();
    const result = await runRunner(managed.runId, managed.baseUrl, [
      process.execPath,
      "-e",
      "process.stdout.write('managed-command-passed AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')",
    ]);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("managed-command-passed");

    const detail = (await app!.inject({ method: "GET", url: `/api/runs/${managed.runId}` })).json();
    const maker = detail.stages.find((stage: any) => stage.role === "maker");
    expect(detail.run).toMatchObject({
      status: "waiting",
      currentStageId: maker.id,
      waitingReason: expect.stringContaining("independent checker"),
    });
    expect(detail.stages.filter((stage: any) => stage.position < maker.position).map((stage: any) => stage.status))
      .toEqual(["passed", "passed", "passed", "passed", "skipped"]);
    expect(maker).toMatchObject({ status: "waiting", waitingReason: expect.stringContaining("independent checker") });
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ status: "running", checkerStatus: "pending" });
    expect(detail.attempts[0].artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.verifications[0]).toMatchObject({ status: "passed", exitCode: 0 });
    expect(detail.evidence[0]).toMatchObject({
      requirementId: detail.requirements[0].id,
      status: "pass",
      kind: "command",
      provenance: "runtime",
      exitCode: 0,
      artifactDigest: detail.attempts[0].artifactDigest,
    });
    expect(detail.artifacts[0]).toMatchObject({ verificationStatus: "verified", digest: detail.attempts[0].artifactDigest });
    expect(detail.agents[0]).toMatchObject({ status: "finished", currentAction: expect.stringContaining("checker") });
    expect(detail.events.some((event: any) => event.type === "checker.requested")).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(JSON.stringify(detail)).toContain("[REDACTED]");
  });

  it("records a failed command as a retryable immutable attempt", async () => {
    const managed = await createManagedRun();
    const result = await runRunner(managed.runId, managed.baseUrl, [
      process.execPath,
      "-e",
      "process.stderr.write('managed-command-failed'); process.exit(7)",
    ]);
    expect(result.code).toBe(7);
    const detail = (await app!.inject({ method: "GET", url: `/api/runs/${managed.runId}` })).json();
    expect(detail.attempts[0]).toMatchObject({ status: "failure", checkerStatus: "pending" });
    expect(detail.verifications[0]).toMatchObject({ status: "failed", exitCode: 7 });
    expect(detail.evidence[0]).toMatchObject({ status: "fail", exitCode: 7 });
    expect(detail.stages.find((stage: any) => stage.role === "maker").status).toBe("active");
    expect(detail.agents[0].status).toBe("error");
    expect(detail.events.some((event: any) => event.type === "attempt.failed")).toBe(true);
  });

  it.each([
    ["cancelled", "cancelled", "finished"],
    ["failed", "failure", "error"],
    ["timed_out", "failure", "error"],
    ["capped", "failure", "error"],
  ] as const)("stops the local command when Admin makes the run %s", async (status, attemptStatus, agentStatus) => {
    const managed = await createManagedRun();
    const running = runRunner(managed.runId, managed.baseUrl, [
      process.execPath,
      "-e",
      "process.stdout.write('long-command-started'); setInterval(() => {}, 1000)",
    ]);
    await waitFor(async () => {
      const detail = (await app!.inject({ method: "GET", url: `/api/runs/${managed.runId}` })).json();
      return detail.attempts.length === 1;
    });
    const terminal = await app!.inject({
      method: "PATCH",
      url: `/api/runs/${managed.runId}/status`,
      headers: OPERATOR,
      payload: { status, reason: `Runner ${status} integration test`, expectedStatus: "running" },
    });
    expect(terminal.statusCode).toBe(200);
    const result = await running;
    if (process.platform === "win32") expect(result.code).not.toBe(0);
    else expect(result.code).toBe(143);
    expect(result.stderr).toContain(`run ${status} in Admin`);
    const detail = (await app!.inject({ method: "GET", url: `/api/runs/${managed.runId}` })).json();
    expect(detail.run.status).toBe(status);
    expect(detail.attempts[0].status).toBe(attemptStatus);
    expect(detail.agents[0].status).toBe(agentStatus);
  }, 15_000);

  async function createManagedRun(): Promise<{ runId: string; baseUrl: string }> {
    app = await buildApp({ databasePath: ":memory:", demo: false, enableTestAuthHeaders: true });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server address");
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: OPERATOR,
      payload: { goal: "Verify the managed command runner", requirements: REQUIREMENTS },
    });
    expect(created.statusCode).toBe(201);
    return { runId: created.json().id, baseUrl: `http://127.0.0.1:${address.port}` };
  }
});

function runWithUnavailableAdmin(expectedCode: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runRunner("unreachable-admin-test", "http://127.0.0.1:1", [
    process.execPath,
    "-e",
    `process.stdout.write("command-ran-${expectedCode}"); process.exit(${expectedCode})`,
  ]);
}

function runRunner(
  runId: string,
  baseUrl: string,
  command: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      runner,
      "--run",
      runId,
      "--",
      ...command,
    ], {
      env: { ...process.env, LOOP_ADMIN_URL: baseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for runner state");
}
