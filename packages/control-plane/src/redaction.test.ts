import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "./redaction.js";

describe("redaction", () => {
  it("redacts common inline credentials", () => {
    const result = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(result.redacted).toBe(true);
    expect(result.value).toBe("Authorization: [REDACTED]");
  });

  it("redacts sensitive keys recursively without mutating safe values", () => {
    const result = redactValue({
      command: "npm test",
      headers: { authorization: "secret", accept: "application/json" },
      nested: [{ api_key: "secret" }, { outcome: "passed" }],
    });
    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      command: "npm test",
      headers: { authorization: "[REDACTED]", accept: "application/json" },
      nested: [{ api_key: "[REDACTED]" }, { outcome: "passed" }],
    });
  });

  it("reports untouched public content", () => {
    expect(redactValue({ message: "Tests passed", exitCode: 0 })).toEqual({
      value: { message: "Tests passed", exitCode: 0 },
      redacted: false,
    });
  });
});
