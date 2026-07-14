import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "./redaction.js";

describe("redaction", () => {
  it("redacts common inline credentials", () => {
    const result = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(result.redacted).toBe(true);
    expect(result.value).toBe("Authorization: [REDACTED]");
  });

  it.each([
    ["access key id", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AWS_ACCESS_KEY_ID=[REDACTED]"],
    ["secret access key", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["session token", "AWS_SESSION_TOKEN='IQoJb3JpZ2luX2VjEExample+/='", "AWS_SESSION_TOKEN='[REDACTED]'"],
    ["common assignment", 'client_secret: "correct horse battery staple"', 'client_secret: "[REDACTED]"'],
    ["npm token", "publishing npm_abcdefghijklmnopqrstuvwxyz0123456789 now", "publishing [REDACTED] now"],
    ["npm token assignment", "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789", "NPM_TOKEN=[REDACTED]"],
    ["database URL", "postgresql://loop:p%40ssword@localhost:5432/admin", "postgresql://loop:[REDACTED]@localhost:5432/admin"],
    ["HTTP URL", "https://operator:hunter2@example.test/private", "https://operator:[REDACTED]@example.test/private"],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactText(input)).toEqual({ value: expected, redacted: true });
  });

  it("redacts sensitive keys recursively without mutating safe values", () => {
    const result = redactValue({
      command: "npm test",
      headers: { authorization: "secret", accept: "application/json" },
      nested: [{ api_key: "secret" }, { privateKey: "secret" }, { outcome: "passed" }],
    });
    expect(result.redacted).toBe(true);
    expect(result.value).toEqual({
      command: "npm test",
      headers: { authorization: "[REDACTED]", accept: "application/json" },
      nested: [{ api_key: "[REDACTED]" }, { privateKey: "[REDACTED]" }, { outcome: "passed" }],
    });
  });

  it("preserves non-secret structured metadata whose names mention credentials", () => {
    const result = redactValue({
      tokenBudget: 120,
      passwordPolicy: "minimum 12 characters",
      token_count: 4,
      secretManagement: "external vault",
      monkey: "banana",
    });
    expect(result).toEqual({
      value: {
        tokenBudget: 120,
        passwordPolicy: "minimum 12 characters",
        token_count: 4,
        secretManagement: "external vault",
        monkey: "banana",
      },
      redacted: false,
    });
  });

  it.each([
    [
      "closing command quotes and parentheses",
      `node -e "use(AWS_SECRET_ACCESS_KEY=top-secret-value)"`,
      `node -e "use(AWS_SECRET_ACCESS_KEY=[REDACTED])"`,
    ],
    ["comma", "send(NPM_TOKEN=top-secret-value, next)", "send(NPM_TOKEN=[REDACTED], next)"],
    ["semicolon", "NPM_TOKEN=top-secret-value; npm test", "NPM_TOKEN=[REDACTED]; npm test"],
    ["closing bracket", "[NPM_TOKEN=top-secret-value]", "[NPM_TOKEN=[REDACTED]]"],
    ["closing brace", "{NPM_TOKEN=top-secret-value}", "{NPM_TOKEN=[REDACTED]}"],
    ["single quote", "run('NPM_TOKEN=top-secret-value')", "run('NPM_TOKEN=[REDACTED]')"],
  ])("preserves the %s after an unquoted assignment", (_label, input, expected) => {
    expect(redactText(input)).toEqual({ value: expected, redacted: true });
  });

  it("reports untouched public content", () => {
    expect(redactValue({ message: "Tests passed", exitCode: 0 })).toEqual({
      value: { message: "Tests passed", exitCode: 0 },
      redacted: false,
    });
  });

  it("does not mutate an already-redacted assignment", () => {
    expect(redactText("NPM_TOKEN=[REDACTED]")).toEqual({
      value: "NPM_TOKEN=[REDACTED]",
      redacted: false,
    });
  });

  it.each([
    "The token budget is 12000 and the password policy requires 12 characters.",
    "monkey=banana keyboard=mechanical status=passed",
    "AKIA is a deployment label, not an access key id.",
    "sha256:0123456789abcdef0123456789abcdef01234567",
    "https://example.test/docs?topic=secret-management",
  ])("does not damage ordinary prose: %s", (input) => {
    expect(redactText(input)).toEqual({ value: input, redacted: false });
  });
});
