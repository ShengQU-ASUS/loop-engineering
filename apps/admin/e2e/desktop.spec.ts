import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectRealApi } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operational overview" })).toBeVisible();
  await expectRealApi(page);
});

test("opens a live run from overview and exposes activity, attempts, and evidence", async ({ page }) => {
  await expect(page.getByText("Runtime telemetry", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Add resilient webhook delivery/ }).first().click();

  await expect(page).toHaveURL(/\/runs\/run-webhook$/);
  await expect(page.getByRole("heading", { name: /Add resilient webhook delivery/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stage progression" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Observable activity" })).toBeVisible();

  await page.getByRole("tab", { name: /Attempts/ }).click();
  await expect(page.getByRole("heading", { name: "Immutable attempts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attempt 2" })).toBeVisible();

  await page.getByRole("tab", { name: /Verification & evidence/ }).click();
  await expect(page.getByRole("heading", { name: "Requirement traceability" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deterministic verification" })).toBeVisible();

  await page.getByRole("tab", { name: /Activity & logs/ }).click();
  await expect(page.getByRole("heading", { name: "Observable activity" })).toBeVisible();
});

test("creates a run, marks it running, and pauses it through audited controls", async ({ page }) => {
  const objective = "Prove the local admin can create and control a generic engineering run";

  await page.getByRole("button", { name: "New run" }).click();
  await expect(page.getByRole("dialog", { name: "Create a queued loop run" })).toBeVisible();
  await page.getByLabel("Project name").fill("E2E control plane");
  await page.getByLabel("Repository path").fill("/tmp/e2e-control-plane");
  await page.getByLabel("Objective").fill(objective);
  await page.getByLabel("Title", { exact: true }).fill("Audited run control");
  await page.getByLabel("Description", { exact: true }).fill("Run state changes must come from real API mutations.");
  await page.getByLabel("Acceptance criteria", { exact: true }).fill("The UI creates a queued run, marks it running, and pauses it with persisted reasons.");
  await page.getByRole("button", { name: "Create queued run" }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: objective })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark running", exact: true })).toBeVisible();
  await expect(page.getByText(/--cwd \/tmp\/e2e-control-plane/)).toBeVisible();

  await page.getByRole("button", { name: "Mark running", exact: true }).click();
  await expect(page.getByText(/does not launch Codex, Claude, or another process/i)).toBeVisible();
  await page.getByLabel("Required reason").fill("Begin the bounded E2E verification run");
  await page.getByRole("button", { name: "Confirm mark running" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Required reason").fill("Pause after verifying the real state transition");
  await page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
});

test("records a scoped approval decision and moves it to history", async ({ page }) => {
  const reason = "Release evidence and the bound candidate digest were reviewed";

  await page.getByRole("link", { name: /^Approvals/ }).click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByText("Publish signed desktop release", { exact: true })).toBeVisible();
  const reviewDecision = page.getByRole("button", { name: "Review decision" });
  await reviewDecision.focus();
  await expect(reviewDecision).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Record approval decision" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();

  const modalA11y = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(seriousViolations(modalA11y.violations)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Record approval decision" })).toBeHidden();
  await expect(reviewDecision).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Approve" })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Reject" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Decision reason")).toBeFocused();
  await page.keyboard.type(reason);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Approve action" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Approval queue is clear", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /History/ }).click();
  const historyEntry = page.locator("article").filter({ hasText: "Publish signed desktop release" });
  await expect(historyEntry).toContainText(reason);
  await expect(historyEntry.getByText("Approved", { exact: true })).toBeVisible();
});

test("global pause blocks dispatch and can be safely resumed", async ({ page }) => {
  let cleanupRequired = false;

  try {
    await page.getByRole("button", { name: "Pause dispatch" }).click();
    let dialog = page.getByRole("dialog", { name: "Pause workspace dispatch" });
    await dialog.getByLabel("Required reason").fill("Hold new work while the E2E guardrail is verified");
    await dialog.getByRole("button", { name: "Pause dispatch" }).click();

    await expect(page.getByRole("button", { name: "Resume dispatch" })).toBeVisible();
    cleanupRequired = true;
    await expect(page.getByRole("button", { name: "New run" })).toBeDisabled();
    await expect(page.getByText("Global Pause", { exact: true })).toBeVisible();

    const blockedCreate = await page.request.post("/api/runs", {
      data: {
        goal: "This E2E run must be rejected while global dispatch is paused",
        requirements: [{
          title: "Respect global pause",
          description: "New managed runs stay blocked while dispatch is paused.",
          acceptanceCriteria: "The create request returns GLOBAL_PAUSE.",
        }],
      },
    });
    expect(blockedCreate.status()).toBe(409);
    await expect(blockedCreate.json()).resolves.toMatchObject({ error: { code: "GLOBAL_PAUSE" } });

    await page.getByRole("button", { name: "Resume dispatch" }).click();
    dialog = page.getByRole("dialog", { name: "Resume workspace dispatch" });
    await dialog.getByLabel("Required reason").fill("Global pause behavior is verified and dispatch may continue");
    await dialog.getByRole("button", { name: "Resume dispatch" }).click();

    await expect(page.getByRole("button", { name: "Pause dispatch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New run" })).toBeEnabled();
    cleanupRequired = false;
  } finally {
    if (cleanupRequired) {
      const stateResponse = await page.request.get("/api/settings/global-pause");
      const state = await stateResponse.json() as { paused: boolean; version: number };
      if (state.paused) {
        await page.request.patch("/api/settings/global-pause", {
          data: { paused: false, reason: "E2E cleanup after interrupted global pause test", expectedVersion: state.version },
        });
      }
    }
  }
});

test("has no serious or critical axe violations on core live views", async ({ page }) => {
  const overview = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(seriousViolations(overview.violations)).toEqual([]);

  await page.goto("/runs/run-webhook");
  await expect(page.getByRole("heading", { name: /Add resilient webhook delivery/ })).toBeVisible();
  const runDetail = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(seriousViolations(runDetail.violations)).toEqual([]);
});

function seriousViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) }));
}
