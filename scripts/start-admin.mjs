#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const DEMO_RUN_IDS = ["run-webhook", "run-release", "run-deps"];

export function parseAdminArgs(values) {
  const options = { help: false, demo: false, port: undefined, databasePath: undefined };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--demo") {
      options.demo = true;
      continue;
    }
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt >= 0 ? argument.slice(0, equalsAt) : argument;
    const inlineValue = equalsAt >= 0 ? argument.slice(equalsAt + 1) : undefined;
    if (flag !== "--port" && flag !== "--db") throw new Error(`Unknown option '${argument}'`);
    const value = inlineValue || values[index + 1];
    if (!value || (!inlineValue && value.startsWith("--"))) throw new Error(`${flag} requires a value`);
    if (!inlineValue) index += 1;
    if (flag === "--port") options.port = value;
    else options.databasePath = value;
  }
  return options;
}

export function resolveLaunchConfig(options, env = process.env, workspaceRoot = root) {
  const demo = options.demo || env.LOOP_ADMIN_DEMO === "1";
  const rawPort = options.port ?? env.LOOP_ADMIN_PORT ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port/LOOP_ADMIN_PORT must be an integer between 1 and 65535");
  }

  const configuredDatabase = options.databasePath ?? (String(env.LOOP_ADMIN_DB || "").trim() || null);
  const explicitDatabase = configuredDatabase !== null;
  let databasePath = configuredDatabase === ":memory:"
    ? ":memory:"
    : configuredDatabase
      ? resolve(configuredDatabase)
      : resolve(workspaceRoot, ".loop-admin", demo ? "demo.db" : "control-plane.db");
  return { demo, port, databasePath, legacyDemoPath: null, explicitDatabase };
}

export async function protectOperationalDefault(config, workspaceRoot = root) {
  if (config.demo || config.explicitDatabase || await detectDatabaseMode(config.databasePath) !== "demo") return config;
  const databasePath = resolve(workspaceRoot, ".loop-admin", "operational.db");
  if (await detectDatabaseMode(databasePath) === "demo") {
    throw new Error("Both default databases contain demo data; choose an operational path with --db");
  }
  return { ...config, legacyDemoPath: config.databasePath, databasePath };
}

export async function detectDatabaseMode(databasePath) {
  if (databasePath === ":memory:" || !existsSync(databasePath)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    let modeRow;
    try {
      modeRow = database.prepare("SELECT value FROM settings WHERE key = 'workspace_data_mode'").get();
    } catch {
      return null;
    }
    if (modeRow?.value === "demo" || modeRow?.value === "operational") return modeRow.value;

    const placeholders = DEMO_RUN_IDS.map(() => "?").join(", ");
    const legacy = database.prepare(`SELECT COUNT(*) AS count FROM runs WHERE id IN (${placeholders})`)
      .get(...DEMO_RUN_IDS);
    if (legacy.count === DEMO_RUN_IDS.length) {
      database.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('workspace_data_mode', 'demo')").run();
      return "demo";
    }
    return null;
  } finally {
    database.close();
  }
}

function run(args, env = process.env) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : npm;
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function usage() {
  process.stdout.write(`Loop Engineering Admin

Usage:
  npm run admin -- [--port PORT] [--db PATH] [--demo]

Options:
  --port PORT  API and UI port (default: 8787)
  --db PATH    SQLite database path (default: .loop-admin/control-plane.db)
  --demo       Use opt-in snapshot data in the separate .loop-admin/demo.db
  --help       Show this help

Node.js 22.13+ is the only prerequisite. Docker, Rancher, and an external
database are not required.
`);
}

async function main() {
  let options;
  let config;
  try {
    options = parseAdminArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
  } catch (error) {
    process.stderr.write(`Loop Engineering Admin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Run 'npm run admin -- --help' for usage.\n");
    process.exit(2);
  }

  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
    console.error(`Loop Engineering Admin requires Node.js 22.13 or newer (current: ${process.versions.node}).`);
    console.error("Install a current Node.js LTS release, then run npm run admin again.");
    process.exit(1);
  }

  try {
    config = await protectOperationalDefault(resolveLaunchConfig(options));
  } catch (error) {
    process.stderr.write(`Loop Engineering Admin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  if (config.legacyDemoPath) {
    console.warn(`Legacy demo data remains at ${config.legacyDemoPath}.`);
    console.warn(`Starting a clean operational workspace at ${config.databasePath}.`);
  }

  const vitePath = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  const lockfilePath = resolve(root, "package-lock.json");
  const dependencyStampPath = resolve(root, "node_modules", ".loop-admin-lock.sha256");
  const lockfileDigest = createHash("sha256").update(readFileSync(lockfilePath)).digest("hex");
  const installedDigest = existsSync(dependencyStampPath) ? readFileSync(dependencyStampPath, "utf8").trim() : "";

  if (!existsSync(vitePath) || installedDigest !== lockfileDigest) {
    console.log("Installing Loop Engineering Admin dependencies...");
    run(["install"]);
    writeFileSync(dependencyStampPath, `${lockfileDigest}\n`, "utf8");
  }

  console.log("Building Loop Engineering Admin...");
  run(["run", "admin:build"]);

  const host = process.env.LOOP_ADMIN_HOST?.trim() || "127.0.0.1";
  const env = {
    ...process.env,
    LOOP_ADMIN_DB: config.databasePath,
    LOOP_ADMIN_DEMO: config.demo ? "1" : "0",
    LOOP_ADMIN_PORT: String(config.port),
  };

  console.log(`Starting Loop Engineering Admin at http://${host}:${config.port}`);
  console.log(`Data: ${config.databasePath} (${config.demo ? "demo snapshots" : "operational"})`);
  run(["run", "start", "--workspace", "@loop-engineering/admin"], env);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void main();
