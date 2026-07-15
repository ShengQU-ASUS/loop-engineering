#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

class AdminApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "capped"]);

const divider = process.argv.indexOf("--", 2);
if (divider < 0) fail("Separate runner options from the command with --");

const options = parseOptions(process.argv.slice(2, divider));
const command = process.argv[divider + 1];
const commandArgs = process.argv.slice(divider + 2);
if (!command) fail("A command is required after --");
if (!options.run) fail("--run is required");

const baseUrl = String(process.env.LOOP_ADMIN_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = String(process.env.LOOP_ADMIN_TOKEN || "").trim();
const cwd = resolve(options.cwd || process.cwd());
const displayCommand = [command, ...commandArgs].map(shellDisplay).join(" ");
const invocationId = randomUUID();
const startedAt = Date.now();
const evidenceHash = createHash("sha256").update(`command\0${displayCommand}\0cwd\0${cwd}\0`);
let outputPreview = "";
let outputBytes = 0;
let eventQueue = Promise.resolve();
let lastTelemetryWarning = "";

let lifecycle;
try {
  lifecycle = await prepareManagedLifecycle();
} catch (error) {
  if (error instanceof AdminApiError) {
    process.stderr.write(`loop-admin-run: managed lifecycle rejected: ${error.message}\n`);
    process.exit(2);
  }
  reportTelemetryError(error);
  lifecycle = null;
}

if (lifecycle) {
  await sendEvent("tool.started", `Started ${displayCommand}`, "info", {
    command: displayCommand,
    cwd,
    managedLifecycle: true,
  }).catch(reportTelemetryError);
}

let spawnError = null;
let terminalStatusFromAdmin = null;
let terminating = false;
let forceKillTimer;
const child = spawn(command, commandArgs, {
  cwd,
  env: process.env,
  shell: process.platform === "win32" && !/\.(?:exe|com)$/i.test(command),
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (data) => {
  process.stdout.write(data);
  captureOutput("stdout", data);
  enqueueChunks("log.stdout", data.toString(), "info");
});

child.stderr.on("data", (data) => {
  process.stderr.write(data);
  captureOutput("stderr", data);
  enqueueChunks("log.stderr", data.toString(), "warning");
});

child.on("error", (error) => {
  spawnError = error;
  if (lifecycle) {
    eventQueue = eventQueue.then(() => sendEvent("tool.failed", `${displayCommand} failed to start`, "error", {
      command: displayCommand,
      error: error.message,
    })).catch(reportTelemetryError);
  }
});

const terminalStatusPoll = lifecycle ? setInterval(async () => {
  if (terminating) return;
  try {
    const detail = await request(`/api/runs/${encodeURIComponent(options.run)}`);
    if (!TERMINAL_RUN_STATUSES.has(detail.run.status)) return;
    terminalStatusFromAdmin = detail.run.status;
    terminating = true;
    process.stderr.write(`\nloop-admin-run: run ${terminalStatusFromAdmin} in Admin; stopping command\n`);
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      forceKillTimer.unref?.();
    }
  } catch (error) {
    reportTelemetryError(error);
  }
}, 750) : null;
terminalStatusPoll?.unref?.();

const result = await new Promise((resolveExit) => {
  child.on("close", (code, signal) => resolveExit({ code, signal }));
});
if (terminalStatusPoll) clearInterval(terminalStatusPoll);
if (forceKillTimer) clearTimeout(forceKillTimer);

const exitCode = spawnError ? 127 : result.code ?? signalExitCode(result.signal);
evidenceHash.update(`exit\0${exitCode}`);
const evidenceDigest = evidenceHash.digest("hex");

await eventQueue;
if (lifecycle && !terminalStatusFromAdmin) {
  try {
    await recordManagedResult(exitCode, evidenceDigest);
  } catch (error) {
    reportTelemetryError(error);
  }
  await sendEvent(exitCode === 0 ? "tool.completed" : "tool.failed",
    `${displayCommand} exited ${exitCode}`, exitCode === 0 ? "info" : "error", {
      command: displayCommand,
      cwd,
      exitCode,
      durationMs: Date.now() - startedAt,
      managedLifecycle: true,
    }).catch(reportTelemetryError);
}

process.exitCode = exitCode;

async function prepareManagedLifecycle() {
  let detail = await request(`/api/runs/${encodeURIComponent(options.run)}`);
  if (detail.run.sourceMode !== "managed") {
    throw new AdminApiError(409, "SNAPSHOT_READ_ONLY", "The runner cannot attach to a read-only snapshot run");
  }
  if (detail.run.status === "queued") {
    await request(`/api/runs/${encodeURIComponent(options.run)}/actions`, {
      method: "POST",
      body: { action: "start", expectedStatus: "queued" },
    });
    detail = await request(`/api/runs/${encodeURIComponent(options.run)}`);
  }
  if (detail.run.status !== "running") {
    throw new AdminApiError(409, "RUN_NOT_ACTIVE",
      `Run must be queued or running before attachment; current status is '${detail.run.status}'`);
  }

  const makerStage = options.stage
    ? detail.stages.find((stage) => stage.id === options.stage)
    : detail.stages.find((stage) => stage.role === "maker");
  if (!makerStage) throw new AdminApiError(422, "MAKER_STAGE_REQUIRED", "Run has no maker stage to attach");
  if (makerStage.role !== "maker") {
    throw new AdminApiError(422, "INVALID_MAKER_STAGE", `Stage '${makerStage.id}' is not a maker stage`);
  }

  const repository = inspectRepository(cwd);
  for (const stage of detail.stages.filter((candidate) => candidate.position < makerStage.position)) {
    if (["passed", "skipped"].includes(stage.status)) continue;
    if (["rejected", "failed", "blocked"].includes(stage.status)) {
      throw new AdminApiError(409, "STAGE_BLOCKED", `Preceding stage '${stage.key}' is '${stage.status}'`);
    }
    if (stage.status === "pending" && stage.key === "worktree" && !repository?.linkedWorktree) {
      await transitionStage(stage.id, "skipped", "Runner uses the caller-supplied checkout; no linked Git worktree was detected");
      continue;
    }
    if (stage.status === "pending" || stage.status === "waiting") await transitionStage(stage.id, "active");
    await transitionStage(stage.id, "passed");
  }

  detail = await request(`/api/runs/${encodeURIComponent(options.run)}`);
  const refreshedMaker = detail.stages.find((stage) => stage.id === makerStage.id);
  const attempts = detail.attempts
    .filter((attempt) => attempt.stageId === makerStage.id)
    .sort((left, right) => left.number - right.number);
  const previous = attempts.at(-1) ?? null;
  if (previous?.status === "running") {
    throw new AdminApiError(409, "ATTEMPT_RUNNING",
      `Attempt ${previous.number} is still waiting for an independent checker or completion`);
  }
  if (previous?.status === "success") {
    throw new AdminApiError(409, "ATTEMPT_SUCCEEDED", "The latest attempt already passed its independent checker");
  }
  if (refreshedMaker.status === "pending" || refreshedMaker.status === "waiting") {
    await transitionStage(refreshedMaker.id, "active");
  } else if (refreshedMaker.status !== "active") {
    throw new AdminApiError(409, "MAKER_STAGE_CLOSED", `Maker stage is '${refreshedMaker.status}' and cannot accept an attempt`);
  }

  const agentId = String(options.agent || `runner-${invocationId}`).slice(0, 200);
  const sessionId = String(options.session || `session-${invocationId}`).slice(0, 200);
  const attemptId = String(options.attempt || `attempt-${invocationId}`).slice(0, 200);
  await sendFact({
    id: factId(),
    type: "agent.heartbeat",
    agentId,
    sessionId,
    name: options.name || "Local command runner",
    role: "maker",
    runtime: options.runtime || "loop-admin-run",
    model: options.model || "external command",
    status: "running",
    currentAction: `Executing ${displayCommand}`,
    worktreePath: cwd,
  });

  const retry = retryLineage(previous, detail.reviews);
  await sendFact({
    id: factId(),
    type: "attempt.started",
    attemptId,
    stageId: makerStage.id,
    makerAgentId: agentId,
    makerSessionId: sessionId,
    ...retry,
  });

  if (repository?.linkedWorktree) {
    await sendFact({
      id: factId(),
      type: "worktree.recorded",
      worktreeId: `worktree-${invocationId}`,
      attemptId,
      makerAgentId: agentId,
      makerSessionId: sessionId,
      path: cwd,
      branch: repository.branch || "detached-head",
      commit: repository.head,
      dirty: repository.dirty,
      status: "active",
      expectedVersion: 0,
    });
  }

  return {
    runId: options.run,
    stageId: makerStage.id,
    attemptId,
    agentId,
    sessionId,
    requirements: detail.requirements.filter((requirement) => !requirement.supersededAt),
  };
}

async function recordManagedResult(exitCode, evidenceDigest) {
  const durationMs = Date.now() - startedAt;
  const candidate = await computeCandidateDigest(exitCode, evidenceDigest);
  await sendFact({
    id: factId(),
    type: "attempt.artifact",
    attemptId: lifecycle.attemptId,
    makerAgentId: lifecycle.agentId,
    makerSessionId: lifecycle.sessionId,
    artifactDigest: candidate.digest,
    expectedArtifactDigest: null,
  });
  await sendFact({
    id: factId(),
    type: "artifact.recorded",
    artifactId: `artifact-${invocationId}`,
    attemptId: lifecycle.attemptId,
    agentId: lifecycle.agentId,
    sessionId: lifecycle.sessionId,
    name: candidate.kind === "diff" ? "Repository candidate" : "Command result",
    kind: candidate.kind,
    uri: pathToFileURL(cwd).href,
    digest: candidate.digest,
    sizeBytes: candidate.sizeBytes,
    verificationStatus: exitCode === 0 ? "verified" : "invalid",
    sensitivity: "internal",
  });
  await sendFact({
    id: factId(),
    type: "verification.recorded",
    verificationId: `verification-${invocationId}`,
    attemptId: lifecycle.attemptId,
    agentId: lifecycle.agentId,
    sessionId: lifecycle.sessionId,
    name: options.verification || "Runner command",
    command: displayCommand,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs,
    evidenceDigest,
    artifactDigest: candidate.digest,
    outputPreview: outputPreview || null,
  });

  for (const requirement of lifecycle.requirements) {
    await sendFact({
      id: factId(),
      type: "requirement.evidence",
      evidenceId: `evidence-${randomUUID()}`,
      requirementId: requirement.id,
      attemptId: lifecycle.attemptId,
      agentId: lifecycle.agentId,
      sessionId: lifecycle.sessionId,
      kind: "command",
      status: exitCode === 0 ? "pass" : "fail",
      summary: `${displayCommand} exited ${exitCode}; the independent checker must assess relevance to '${requirement.title}'.`,
      command: displayCommand,
      exitCode,
      rawLogRef: null,
      artifactDigest: candidate.digest,
      provenance: "runtime",
      expiresAt: null,
    });
  }

  if (exitCode === 0) {
    await transitionStage(lifecycle.stageId, "waiting", "Verification recorded; awaiting an independent checker verdict");
    await request(`/api/runs/${encodeURIComponent(options.run)}/status`, {
      method: "PATCH",
      body: {
        status: "waiting",
        expectedStatus: "running",
        reason: "Candidate verification recorded; awaiting an independent checker verdict",
      },
    });
    await sendEvent("checker.requested", "Candidate is ready for an independent checker", "warning", {
      attemptId: lifecycle.attemptId,
      artifactDigest: candidate.digest,
      requirements: lifecycle.requirements.map((requirement) => requirement.id),
    }, candidate.digest);
    await sendFact({
      id: factId(),
      type: "agent.heartbeat",
      agentId: lifecycle.agentId,
      sessionId: lifecycle.sessionId,
      name: options.name || "Local command runner",
      role: "maker",
      runtime: options.runtime || "loop-admin-run",
      model: options.model || "external command",
      status: "waiting",
      currentAction: "Verification recorded; awaiting an independent checker verdict",
      worktreePath: cwd,
    });
    return;
  }

  await sendFact({
    id: factId(),
    type: "attempt.finished",
    attemptId: lifecycle.attemptId,
    makerAgentId: lifecycle.agentId,
    makerSessionId: lifecycle.sessionId,
    status: "failure",
    summary: `${displayCommand} failed with exit code ${exitCode}`,
    errorSignature: spawnError ? "COMMAND_SPAWN_FAILED" : `COMMAND_EXIT_${exitCode}`,
    expectedStatus: "running",
  });
  await sendFact({
    id: factId(),
    type: "agent.heartbeat",
    agentId: lifecycle.agentId,
    sessionId: lifecycle.sessionId,
    name: options.name || "Local command runner",
    role: "maker",
    runtime: options.runtime || "loop-admin-run",
    model: options.model || "external command",
    status: "error",
    currentAction: `${displayCommand} failed with exit code ${exitCode}`,
    worktreePath: cwd,
  });
}

function retryLineage(previous, reviews) {
  if (!previous) return {};
  const review = [...reviews].reverse().find((candidate) => candidate.attemptId === previous.id) ?? null;
  if (["rejected", "escalated"].includes(previous.status) && !review) {
    throw new AdminApiError(409, "RETRY_REVIEW_REQUIRED", "Rejected attempts require immutable checker feedback before retry");
  }
  return {
    previousAttemptId: previous.id,
    feedbackReviewId: review?.id ?? null,
    feedbackSummary: review?.summary ?? `Retry after attempt ${previous.number} ended with status '${previous.status}'.`,
  };
}

async function transitionStage(stageId, status, reason) {
  return request(`/api/runs/${encodeURIComponent(options.run)}/stages/${encodeURIComponent(stageId)}`, {
    method: "PATCH",
    body: { status, ...(reason ? { reason } : {}) },
  });
}

async function sendFact(body) {
  return request(`/api/runs/${encodeURIComponent(options.run)}/runtime-facts`, { method: "POST", body });
}

function enqueueChunks(type, value, severity) {
  if (!lifecycle) return;
  for (let offset = 0; offset < value.length; offset += 16_000) {
    const chunk = value.slice(offset, offset + 16_000);
    eventQueue = eventQueue
      .then(() => sendEvent(type, chunk.trimEnd() || " ", severity, { stream: type.slice(4), chunk }))
      .catch(reportTelemetryError);
  }
}

function captureOutput(stream, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  outputBytes += buffer.byteLength;
  evidenceHash.update(`${stream}\0`).update(buffer);
  if (outputPreview.length < 19_500) {
    outputPreview += `[${stream}] ${buffer.toString("utf8")}`.slice(0, 19_500 - outputPreview.length);
  }
}

async function sendEvent(type, message, severity, payload, artifactDigest = null) {
  if (!lifecycle) return null;
  return request("/api/events", {
    method: "POST",
    body: {
      runId: lifecycle.runId,
      stageId: lifecycle.stageId,
      attemptId: lifecycle.attemptId,
      type,
      severity,
      message,
      payload,
      provenance: "runtime",
      actor: lifecycle.agentId,
      correlationId: invocationId,
      artifactDigest,
      occurredAt: new Date().toISOString(),
    },
  });
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method || "GET",
    signal: AbortSignal.timeout(5_000),
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const code = payload?.error?.code || `HTTP_${response.status}`;
    const message = payload?.error?.message || String(payload || response.statusText);
    throw new AdminApiError(response.status, code, `${code}: ${message}`);
  }
  return payload;
}

function inspectRepository(directory) {
  const head = git(directory, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = git(directory, ["branch", "--show-current"]) || "";
  const status = git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]) || "";
  return {
    head,
    branch,
    dirty: status.length > 0,
    linkedWorktree: Boolean(gitDir && commonDir && resolve(gitDir) !== resolve(commonDir)),
  };
}

async function computeCandidateDigest(exitCode, evidenceDigest) {
  const repository = inspectRepository(cwd);
  if (!repository) {
    const digest = createHash("sha256")
      .update(`command-result\0${displayCommand}\0${cwd}\0${exitCode}\0${evidenceDigest}`)
      .digest("hex");
    return { digest, kind: "log", sizeBytes: outputBytes };
  }

  const hash = createHash("sha256").update(`git-candidate\0${repository.head}\0`);
  const diff = gitBuffer(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  hash.update(diff);
  let sizeBytes = diff.byteLength;
  const untracked = gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\0").filter(Boolean).sort();
  for (const relativePath of untracked) {
    hash.update(`untracked\0${relativePath}\0`);
    try {
      for await (const chunk of createReadStream(resolve(cwd, relativePath))) {
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
      }
    } catch (error) {
      hash.update(`unreadable\0${error instanceof Error ? error.code || error.message : String(error)}`);
    }
  }
  return { digest: hash.digest("hex"), kind: "diff", sizeBytes };
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitBuffer(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : Buffer.alloc(0);
}

function factId() {
  return `fact-${randomUUID()}`;
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return signal ? 128 + (numbers[signal] || 0) : 1;
}

function shellDisplay(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function reportTelemetryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastTelemetryWarning) return;
  lastTelemetryWarning = message;
  process.stderr.write(`\nloop-admin telemetry warning: ${message}\n`);
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value) fail(`Invalid runner option '${flag || ""}'`);
    result[flag.slice(2)] = value;
  }
  return result;
}

function fail(message) {
  process.stderr.write(`loop-admin-run: ${message}\n`);
  process.stderr.write("Usage: npm run admin:run -- --run RUN_ID [--stage ID] [--cwd PATH] [--runtime NAME] [--model NAME] -- command [args...]\n");
  process.exit(2);
}
