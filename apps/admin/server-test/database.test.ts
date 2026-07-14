import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATABASE_PATH,
  findWorkspaceRoot,
  resolveDefaultDatabasePath,
} from "../server/database.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const expectedDatabasePath = join(workspaceRoot, ".loop-admin", "control-plane.db");

describe("default SQLite path", () => {
  it("resolves the repository root from source and compiled server locations", () => {
    const sourceDirectory = join(workspaceRoot, "apps", "admin", "server");
    const compiledDirectory = join(workspaceRoot, "apps", "admin", "dist", "server");

    expect(findWorkspaceRoot(sourceDirectory)).toBe(workspaceRoot);
    expect(findWorkspaceRoot(compiledDirectory)).toBe(workspaceRoot);
    expect(resolveDefaultDatabasePath(sourceDirectory)).toBe(expectedDatabasePath);
    expect(resolveDefaultDatabasePath(compiledDirectory)).toBe(expectedDatabasePath);
  });

  it("uses the repository-local database by default", () => {
    expect(DEFAULT_DATABASE_PATH).toBe(expectedDatabasePath);
  });
});
