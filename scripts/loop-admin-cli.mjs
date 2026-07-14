#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [command, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const baseUrl = String(process.env.LOOP_ADMIN_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = String(process.env.LOOP_ADMIN_TOKEN || "").trim();

if (!command || command === "help" || command === "--help" || args.help) usage();

const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

try {
  let result;
  switch (command) {
    case "health":
      result = await request("/api/health");
      break;
    case "create": {
      const goal = required(args.goal, "--goal");
      const requirements = await resolveCreateRequirements(args, goal);
      result = await request("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          loopId: args.loop,
          projectName: args.project || "Local project",
          repositoryPath: args.repo || null,
          runtime: args.runtime || "generic",
          model: args.model || "configured default",
          goal,
          automationLevel: args.level || "L2",
          risk: args.risk || "medium",
          requirements,
        }),
      });
      break;
    }
    case "event":
      result = await request("/api/events", {
        method: "POST",
        body: JSON.stringify({
          runId: required(args.run, "--run"),
          stageId: args.stage || null,
          attemptId: args.attempt || null,
          type: required(args.type, "--type"),
          severity: args.severity || "info",
          message: required(args.message, "--message"),
          payload: args.payload ? JSON.parse(args.payload) : {},
          provenance: args.provenance || "runtime",
          actor: "client-reported",
          correlationId: args.correlation || null,
          artifactDigest: args.digest || null,
          occurredAt: args.at || new Date().toISOString(),
        }),
      });
      break;
    case "fact":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}/runtime-facts`, {
        method: "POST",
        body: JSON.stringify(await readJsonObject(required(args.file, "--file"))),
      });
      break;
    case "stage":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}/stages/${encodeURIComponent(required(args.stage, "--stage"))}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: required(args.status, "--status"),
          reason: args.reason,
        }),
      });
      break;
    case "verdict":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}/checker-verdicts`, {
        method: "POST",
        body: JSON.stringify(await readJsonObject(required(args.file, "--file"))),
      });
      break;
    case "approval":
      result = await request(`/api/approvals/${encodeURIComponent(required(args.approval, "--approval"))}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision: required(args.decision, "--decision"),
          reason: required(args.reason, "--reason"),
          expectedVersion: requiredInteger(args.version, "--version"),
        }),
      });
      break;
    case "transition":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: required(args.status, "--status"),
          expectedStatus: required(args.expected, "--expected"),
          reason: args.reason,
          blockedOwner: args.owner,
          unblockCondition: args.condition,
        }),
      });
      break;
    case "action":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action: required(args.action, "--action"),
          reason: args.reason,
          expectedStatus: args.expected,
        }),
      });
      break;
    case "show":
      result = await request(`/api/runs/${encodeURIComponent(required(args.run, "--run"))}`);
      break;
    default:
      throw new Error(`Unknown command '${command}'`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`loop-admin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" && body?.error?.message
      ? body.error.message
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

async function readJsonArray(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("--requirements must point to a JSON array");
  return value;
}

async function resolveCreateRequirements(args, goal) {
  const requirementsPath = optional(args.requirements);
  const acceptanceCriteria = optional(args.acceptance);

  if (requirementsPath && acceptanceCriteria) {
    throw new Error("Use only one of --requirements FILE or --acceptance TEXT");
  }
  if (!requirementsPath && !acceptanceCriteria) {
    throw new Error("create requires either --requirements FILE or --acceptance TEXT");
  }
  if (requirementsPath) {
    const requirements = await readJsonArray(requirementsPath);
    if (requirements.length === 0) {
      throw new Error("--requirements must contain at least one requirement");
    }
    return requirements;
  }

  return [{
    title: goal.length <= 500 ? goal : `${goal.slice(0, 497)}...`,
    description: goal,
    acceptanceCriteria,
  }];
}

async function readJsonObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--file must point to a JSON object");
  }
  return value;
}

function required(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredInteger(value, flag) {
  const raw = required(value, flag);
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
  return number;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument '${token}'`);
    const key = token.slice(2);
    if (key === "help") {
      parsed.help = true;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function usage() {
  process.stdout.write(`Loop Engineering Admin CLI

Usage:
  npm run admin:cli -- health
  npm run admin:cli -- create --goal "Implement search" [--project NAME] [--repo PATH]
      [--runtime codex] [--model MODEL] [--level L1|L2|L3] [--risk low|medium|high|critical]
      (--requirements requirements.json | --acceptance "Search returns matching runs")
  npm run admin:cli -- event --run RUN_ID --type tool.completed --message "npm test exited 0"
      [--stage ID] [--attempt ID] [--severity info] [--payload JSON] [--digest SHA256]
  npm run admin:cli -- fact --run RUN_ID --file runtime-fact.json
  npm run admin:cli -- stage --run RUN_ID --stage STAGE_ID --status active|passed|failed [--reason TEXT]
  npm run admin:cli -- verdict --run RUN_ID --file checker-verdict.json
  npm run admin:cli -- approval --approval ID --decision approved|rejected --reason TEXT --version 1
  npm run admin:cli -- transition --run RUN_ID --status succeeded --expected running [--reason TEXT]
  npm run admin:cli -- action --run RUN_ID --action start|pause|resume|cancel|retry|override_breaker
      [--reason TEXT] [--expected STATUS]
  npm run admin:cli -- show --run RUN_ID

Environment:
  LOOP_ADMIN_URL    API base URL (default http://127.0.0.1:8787)
  LOOP_ADMIN_TOKEN  Bearer token required by a non-loopback API
`);
  process.exit(0);
}
