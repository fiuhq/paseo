import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";

test("shows Pure black in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio").first(),
  ).toHaveAccessibleName("System");
  await expect(page.getByRole("radio", { name: "Pure black", exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("keeps the selected workspace visible in Light", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "light-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "light" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(212, 212, 216)");
    await page.screenshot({
      path: testInfo.outputPath("light-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps the selected workspace visible in Pure black", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pure-black-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await page.screenshot({
      path: testInfo.outputPath("pure-black-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiBaseFontSize: 21 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const interfaceSizeInput = page.getByLabel("Interface font size");
  const contentSizeInput = page.getByLabel("Content font size");
  await expect(interfaceSizeInput).toHaveValue("21");
  await expect(contentSizeInput).toHaveValue("21");
  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await expect(interfaceSizeInput).toHaveValue("12");
  await expect(contentSizeInput).toHaveValue("21");
  await expect(sectionTitle).toHaveCSS("font-size", "10px");
});

// Each built-in tile draws its preview in its own theme's colors; System draws its light theme,
// then its dark theme. Comparing against those tiles keeps the expected colors out of the test.
async function previewColors(page: Page, name: string): Promise<string[]> {
  return page
    .getByRole("radio", { name, exact: true })
    .evaluate((tile) =>
      Array.from(tile.querySelectorAll("div"))
        .map((node) => getComputedStyle(node).backgroundColor)
        .filter((color) => color !== "rgba(0, 0, 0, 0)"),
    );
}

async function expectSystemPreviewToShow(page: Page, light: string, dark: string): Promise<void> {
  const lightColors = await previewColors(page, light);
  const darkColors = await previewColors(page, dark);
  expect(lightColors).not.toEqual(darkColors);
  await expect.poll(() => previewColors(page, "System")).toEqual([...lightColors, ...darkColors]);
}

test("previews the configured System pair in the System tile", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({
        theme: "auto",
        systemLightTheme: "claudeLight",
        systemDarkTheme: "midnight",
      }),
    );
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expectSystemPreviewToShow(page, "Claude light", "Midnight");
  await page.screenshot({
    path: testInfo.outputPath("system-tile-configured-pair.png"),
    fullPage: true,
  });
});

test("previews Light and Dark in the System tile by default", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  await expectSystemPreviewToShow(page, "Light", "Dark");
});
