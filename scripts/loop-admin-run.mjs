#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

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
const displayCommand = [command, ...commandArgs].join(" ");
const startedAt = Date.now();
let eventQueue = Promise.resolve();

await sendBestEffort("tool.started", `Started ${displayCommand}`, "info", {
  command: displayCommand,
  cwd,
});

const child = spawn(command, commandArgs, {
  cwd,
  env: process.env,
  shell: false,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (data) => {
  process.stdout.write(data);
  enqueueChunks("log.stdout", data.toString(), "info");
});

child.stderr.on("data", (data) => {
  process.stderr.write(data);
  enqueueChunks("log.stderr", data.toString(), "warning");
});

child.on("error", (error) => {
  eventQueue = eventQueue.then(() => send("tool.failed", `${displayCommand} failed to start`, "error", {
    command: displayCommand,
    error: error.message,
  })).catch(reportTelemetryError);
});

const exitCode = await new Promise((resolveExit) => {
  child.on("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
});

await eventQueue;
await sendBestEffort(exitCode === 0 ? "tool.completed" : "tool.failed", `${displayCommand} exited ${exitCode}`, exitCode === 0 ? "info" : "error", {
  command: displayCommand,
  cwd,
  exitCode,
  durationMs: Date.now() - startedAt,
});

process.exitCode = exitCode;

function enqueueChunks(type, text, severity) {
  for (let offset = 0; offset < text.length; offset += 16_000) {
    const chunk = text.slice(offset, offset + 16_000);
    eventQueue = eventQueue
      .then(() => send(type, chunk.trimEnd() || " ", severity, { stream: type.slice(4), chunk }))
      .catch(reportTelemetryError);
  }
}

async function send(type, message, severity, payload) {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      runId: options.run,
      stageId: options.stage || null,
      attemptId: options.attempt || null,
      type,
      severity,
      message,
      payload,
      provenance: "runtime",
      actor: "client-reported",
      correlationId: options.correlation || null,
      occurredAt: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`telemetry ${response.status}: ${body.slice(0, 500)}`);
  }
}

async function sendBestEffort(type, message, severity, payload) {
  try {
    await send(type, message, severity, payload);
  } catch (error) {
    reportTelemetryError(error);
  }
}

function reportTelemetryError(error) {
  process.stderr.write(`\nloop-admin telemetry warning: ${error instanceof Error ? error.message : String(error)}\n`);
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
  process.stderr.write("Usage: npm run admin:run -- --run RUN_ID [--stage ID] [--attempt ID] [--cwd PATH] -- command [args...]\n");
  process.exit(2);
}
