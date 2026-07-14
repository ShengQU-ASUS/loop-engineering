// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("../../../scripts/loop-admin-run.mjs", import.meta.url));

describe("loop-admin-run", () => {
  it.each([0, 7])("runs the command and preserves exit code %i when Admin is unavailable", async (expectedCode) => {
    const result = await runWithUnavailableAdmin(expectedCode);

    expect(result.code).toBe(expectedCode);
    expect(result.stdout).toContain(`command-ran-${expectedCode}`);
    expect(result.stderr).toContain("loop-admin telemetry warning:");
  });
});

function runWithUnavailableAdmin(expectedCode: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      runner,
      "--run",
      "unreachable-admin-test",
      "--",
      process.execPath,
      "-e",
      `process.stdout.write("command-ran-${expectedCode}"); process.exit(${expectedCode})`,
    ], {
      env: { ...process.env, LOOP_ADMIN_URL: "http://127.0.0.1:1" },
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
