#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`Loop Engineering Admin requires Node.js 22.13 or newer (current: ${process.versions.node}).`);
  console.error("Install a current Node.js LTS release, then run npm run admin again.");
  process.exit(1);
}

function run(args, env = process.env) {
  const result = spawnSync(npm, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

console.log("Building shared control-plane contracts...");
run(["run", "admin:contracts"]);

const databasePath = process.env.LOOP_ADMIN_DB || resolve(root, ".loop-admin", "control-plane.db");
const firstRun = databasePath !== ":memory:" && !existsSync(databasePath);
const env = {
  ...process.env,
  LOOP_ADMIN_DB: databasePath,
  LOOP_ADMIN_DEMO: process.env.LOOP_ADMIN_DEMO ?? (firstRun ? "1" : "0"),
};

console.log(`Starting Loop Engineering Admin at http://127.0.0.1:5173`);
console.log(`Data: ${databasePath}`);
run(["run", "dev", "--workspace", "@loop-engineering/admin"], env);
