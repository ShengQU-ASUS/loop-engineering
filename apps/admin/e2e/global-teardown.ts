import { rmSync } from "node:fs";
import type { FullConfig } from "@playwright/test";

export default function globalTeardown(config: FullConfig): void {
  const testDataDirectory = config.metadata.testDataDirectory;
  if (typeof testDataDirectory === "string" && testDataDirectory.includes("loop-engineering-admin-e2e-")) {
    rmSync(testDataDirectory, { force: true, recursive: true });
  }
}
