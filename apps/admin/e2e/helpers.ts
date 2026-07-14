import { expect, type Page } from "@playwright/test";

export async function expectRealApi(page: Page): Promise<void> {
  await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
  const health = await page.request.get("/api/health");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ status: "ok", database: "connected" });
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));

  expect(dimensions.documentWidth, `document overflows ${dimensions.viewportWidth}px viewport`).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth, `body overflows ${dimensions.viewportWidth}px viewport`).toBeLessThanOrEqual(dimensions.viewportWidth);
}
