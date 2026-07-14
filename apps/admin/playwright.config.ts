import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const testDataDirectory = mkdtempSync(join(tmpdir(), "loop-engineering-admin-e2e-"));
const databasePath = join(testDataDirectory, "control-plane.db");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalTeardown: "./e2e/global-teardown.ts",
  metadata: { testDataDirectory },
  use: {
    baseURL: "http://127.0.0.1:5193",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "concurrently -k -n api,web -c cyan,green \"npm run dev:api\" \"npm run dev:web -- --config e2e/vite.config.ts\"",
    url: "http://127.0.0.1:5193",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      LOOP_ADMIN_E2E_FIXTURE: "1",
      LOOP_ADMIN_DB: databasePath,
      LOOP_ADMIN_PORT: "8793",
    },
  },
  projects: [
    {
      name: "desktop",
      testMatch: "desktop.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      testMatch: "mobile.spec.ts",
      use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
});
