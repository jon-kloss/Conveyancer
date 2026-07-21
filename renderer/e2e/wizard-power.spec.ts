// PLAN SUPPLY CHAIN for Power: choosing "Power" as the goal reveals a
// generator/fuel picker (coal / fuel / NUCLEAR) and the wizard plans a real
// power factory sized to the target MW — NOT an empty factory with a
// "power → world" port. Solve + review only (no accept), so the shared
// serial-suite plan is unchanged.

import { test, expect } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

const COAL_BURN = "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C";

test("planning Power picks a generator type and sizes the plant to the target MW", async ({
  page,
  request,
}) => {
  await resetView(request);
  await page.goto("/");
  await expect(page.getByTestId("map-root")).toBeVisible();

  // P opens the wizard; goal: Power.
  await page.keyboard.press("p");
  await expect(page.getByTestId("wizard-modal")).toBeVisible();
  await page.getByTestId("wizard-item").fill("power");
  await page.getByTestId("wizard-item-option").first().click();

  // The Power goal reveals the generator/fuel selector (net-new). It offers the
  // full generator set — nuclear must be selectable, not just coal-family.
  const fuel = page.getByTestId("wizard-power-fuel");
  await expect(fuel).toBeVisible();
  await expect(fuel.locator("option", { hasText: /nuclear/i })).toHaveCount(1);

  // Pick the coal generator by value (stable across the fixture and real docs)
  // and target 750 MW (= 10 × 75 MW).
  await fuel.selectOption(COAL_BURN);
  await page.fill('[data-testid="wizard-rate"]', "750");
  await page.click('[data-testid="wizard-solve"]');

  // A real reviewable proposal (generators + fuel chain), not an empty factory.
  const review = page.getByTestId("proposal-review");
  await expect(review).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("proposal-item").first()).toBeVisible();
  // The GOAL CHECK credits the plant's generation and reads MET (✓) at the
  // target — the whole point of the fix. A 0-MW / off-material-port read would
  // show 0/750 ✗. (A standalone plant has no power line, so there's no per-grid
  // circuit banner to read; the generation shows in the goal-check + Δ POWER.)
  const goal = page.getByTestId("goal-check");
  await expect(goal).toContainText("750");
  await expect(goal).toContainText("✓");

  // close without accepting — the shared serial-suite plan is unchanged.
  await page.keyboard.press("Escape");
});
