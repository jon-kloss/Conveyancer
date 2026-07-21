// PLAN SUPPLY CHAIN for Power: choosing "Power" as the goal reveals a
// generator/fuel picker and the wizard plans a real power factory (generators +
// fuel chain), NOT an empty factory with a "power → world" port. Solve + review
// only (no accept), so the shared serial-suite plan is unchanged.

import { test, expect } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

test("planning Power picks a generator type and plans generators", async ({ page, request }) => {
  await resetView(request);
  await page.goto("/");
  await expect(page.getByTestId("map-root")).toBeVisible();

  // P opens the wizard; goal: Power.
  await page.keyboard.press("p");
  await expect(page.getByTestId("wizard-modal")).toBeVisible();
  await page.getByTestId("wizard-item").fill("power");
  await page.getByTestId("wizard-item-option").first().click();

  // The Power goal reveals the generator/fuel selector (net-new); default to a
  // coal generator and target 750 MW (= 10 × 75 MW).
  const fuel = page.getByTestId("wizard-power-fuel");
  await expect(fuel).toBeVisible();
  await fuel.selectOption({ label: /Coal/i });
  await page.fill('[data-testid="wizard-rate"]', "750");
  await page.click('[data-testid="wizard-solve"]');

  // A real reviewable proposal (generators + fuel chain), not an empty factory.
  const review = page.getByTestId("proposal-review");
  await expect(review).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("proposal-item").first()).toBeVisible();
  // the power plan surfaces a generation line (the generators it sized)
  await expect(page.getByTestId("proposal-gen-line").first()).toContainText("generation");

  // close without accepting — the plan is unchanged.
  await page.keyboard.press("Escape");
});
