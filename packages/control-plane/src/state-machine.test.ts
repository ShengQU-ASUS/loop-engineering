import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  assertIndependentChecker,
  assertMatchingDigest,
  assertRunTransition,
  assertStageTransition,
  isTerminalRun,
} from "./state-machine.js";

describe("run state machine", () => {
  it("allows the normal lifecycle", () => {
    expect(() => assertRunTransition("queued", "running")).not.toThrow();
    expect(() => assertRunTransition("running", "waiting")).not.toThrow();
    expect(() => assertRunTransition("waiting", "running")).not.toThrow();
    expect(() => assertRunTransition("running", "succeeded")).not.toThrow();
  });

  it("keeps terminal runs immutable", () => {
    for (const status of ["succeeded", "failed", "capped", "timed_out", "cancelled"] as const) {
      expect(isTerminalRun(status)).toBe(true);
      expect(() => assertRunTransition(status, "running")).toThrow(InvalidTransitionError);
    }
  });

  it("does not allow a queued run to claim success", () => {
    expect(() => assertRunTransition("queued", "succeeded")).toThrow(
      "Invalid run transition: queued -> succeeded",
    );
  });

  it("rejects same-state writes", () => {
    expect(() => assertRunTransition("running", "running")).toThrow(
      "Invalid run transition: running -> running",
    );
    expect(() => assertRunTransition("capped", "capped")).toThrow(
      "Invalid run transition: capped -> capped",
    );
  });
});

describe("stage state machine", () => {
  it("allows a blocked stage to resume with an audit-worthy transition", () => {
    expect(() => assertStageTransition("active", "blocked")).not.toThrow();
    expect(() => assertStageTransition("blocked", "active")).not.toThrow();
  });

  it("does not mutate completed evidence stages", () => {
    expect(() => assertStageTransition("passed", "active")).toThrow(InvalidTransitionError);
    expect(() => assertStageTransition("failed", "active")).toThrow(InvalidTransitionError);
  });

  it("rejects same-state writes", () => {
    expect(() => assertStageTransition("active", "active")).toThrow(
      "Invalid stage transition: active -> active",
    );
    expect(() => assertStageTransition("passed", "passed")).toThrow(
      "Invalid stage transition: passed -> passed",
    );
  });
});

describe("checker integrity", () => {
  it("requires different agents and sessions", () => {
    expect(() => assertIndependentChecker("maker", "maker-1", "checker", "checker-1")).not.toThrow();
    expect(() => assertIndependentChecker("maker", "maker-1", "maker", "checker-1")).toThrow(
      "independent agents and sessions",
    );
    expect(() => assertIndependentChecker("maker", "shared", "checker", "shared")).toThrow(
      "independent agents and sessions",
    );
  });

  it("binds a verdict to the current artifact digest", () => {
    expect(() => assertMatchingDigest("sha256:abc", "sha256:abc")).not.toThrow();
    expect(() => assertMatchingDigest("sha256:abc", "sha256:def")).toThrow("current artifact digest");
    expect(() => assertMatchingDigest(null, "sha256:def")).toThrow("no artifact digest");
  });
});
