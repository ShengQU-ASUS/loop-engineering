import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { detectDatabaseMode, parseAdminArgs, protectOperationalDefault, resolveLaunchConfig } from "./start-admin.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./start-admin.mjs", import.meta.url));

test("normal and demo launches resolve to separate databases", () => {
  const workspaceRoot = resolve("/tmp/loop-admin-config-test");
  const operational = resolveLaunchConfig(parseAdminArgs(["--port", "19001"]), {}, workspaceRoot);
  const demo = resolveLaunchConfig(parseAdminArgs(["--demo", "--port=19002"]), {}, workspaceRoot);

  assert.equal(operational.port, 19001);
  assert.equal(operational.demo, false);
  assert.equal(operational.databasePath, join(workspaceRoot, ".loop-admin", "control-plane.db"));
  assert.equal(demo.port, 19002);
  assert.equal(demo.demo, true);
  assert.equal(demo.databasePath, join(workspaceRoot, ".loop-admin", "demo.db"));
});

test("CLI options validate before dependency installation", async () => {
  assert.throws(() => parseAdminArgs(["--unknown"]), /Unknown option/);
  assert.throws(() => parseAdminArgs(["--db"]), /requires a value/);
  assert.throws(() => resolveLaunchConfig(parseAdminArgs(["--port", "0"]), {}), /between 1 and 65535/);

  const { stdout } = await execFileAsync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.match(stdout, /--demo/);
  assert.match(stdout, /Node\.js 22\.13\+/);
  assert.doesNotMatch(stdout, /Building Loop Engineering Admin/);
});

test("legacy sample IDs are persistently marked demo and redirected from the default operational path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-admin-legacy-"));
  const dataDirectory = join(directory, ".loop-admin");
  const legacyPath = join(dataDirectory, "control-plane.db");
  await mkdir(dataDirectory, { recursive: true });
  const database = new DatabaseSync(legacyPath);
  database.exec(`
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE runs(id TEXT PRIMARY KEY) STRICT;
    INSERT INTO runs(id) VALUES ('run-webhook'), ('run-release'), ('run-deps');
  `);
  database.close();

  try {
    assert.equal(await detectDatabaseMode(legacyPath), "demo");
    const reopened = new DatabaseSync(legacyPath);
    assert.equal(reopened.prepare("SELECT value FROM settings WHERE key = 'workspace_data_mode'").get().value, "demo");
    reopened.close();

    const config = await protectOperationalDefault(resolveLaunchConfig(parseAdminArgs([]), {}, directory), directory);
    assert.equal(config.legacyDemoPath, legacyPath);
    assert.equal(config.databasePath, join(dataDirectory, "operational.db"));
    assert.equal(config.demo, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
