import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOPMENT_STAGES, budgetPercent, deriveFreshness } from "./defaults.js";

describe("default development loop", () => {
  it("preserves the maker, deterministic verifier, checker, and final verification chain", () => {
    expect(DEFAULT_DEVELOPMENT_STAGES.map((stage) => stage.key)).toEqual([
      "trigger",
      "intake",
      "requirements",
      "plan",
      "budget_guard",
      "worktree",
      "make",
      "verify",
      "check",
      "approve",
      "apply",
      "final_verify",
      "persist",
    ]);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-07-15T02:00:00.000Z");

  it("only calls recent managed telemetry live", () => {
    expect(deriveFreshness("2026-07-15T01:59:30.000Z", "managed", now)).toBe("live");
    expect(deriveFreshness("2026-07-15T01:57:00.000Z", "managed", now)).toBe("delayed");
    expect(deriveFreshness("2026-07-15T01:50:00.000Z", "managed", now)).toBe("stale");
  });

  it("never calls a file snapshot live", () => {
    expect(deriveFreshness("2026-07-15T01:59:50.000Z", "snapshot", now)).toBe("delayed");
    expect(deriveFreshness(null, "snapshot", now)).toBe("unknown");
  });
});

describe("budgetPercent", () => {
  it("handles normal and invalid limits", () => {
    expect(budgetPercent(80, 100)).toBe(80);
    expect(budgetPercent(120, 100)).toBe(120);
    expect(budgetPercent(10, 0)).toBe(0);
  });
});
