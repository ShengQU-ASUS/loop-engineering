import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoPageOverflow, expectRealApi } from "./helpers";

test("mobile navigation works at 390px and the core views fit at 390px and 320px", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operational overview" })).toBeVisible({ timeout: 10_000 });
  await expectRealApi(page);
  await expectNoPageOverflow(page);
  const overviewA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(seriousViolations(overviewA11y.violations)).toEqual([]);

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navigation = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Close menu" })).toBeVisible();
  await navigation.getByRole("link", { name: /^Runs/ }).click();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/runs/run-webhook");
  await expect(page.getByRole("heading", { name: /Add resilient webhook delivery/ })).toBeVisible();
  await expectNoPageOverflow(page);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: /^Approvals/ }).click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expectNoPageOverflow(page);
});

function seriousViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(({ target }) => target) }));
}
