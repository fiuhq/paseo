import { expect, type Page } from "@playwright/test";

/**
 * Answers the in-app confirmation dialog that `confirmDialog()` shows on browser web,
 * and returns its text (title and message) so a spec can assert what was asked.
 * Call it after the click that raises the confirmation.
 */
export async function answerConfirmDialog(
  page: Page,
  answer: "accept" | "dismiss",
): Promise<string> {
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const text = await dialog.innerText();
  await page
    .getByTestId(answer === "accept" ? "confirm-dialog-confirm" : "confirm-dialog-cancel")
    .click();
  await expect(dialog).toHaveCount(0);
  return text;
}
