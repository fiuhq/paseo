import { expect, test } from "../support/fixtures";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n";

test("a PDF opens in the built-in PDF panel as a blob of type application/pdf", async ({
  page,
}) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pdf-file-panel-",
    repo: { files: [{ path: "report.pdf", content: PDF }] },
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openFileExplorer(page);
    await openFileFromExplorer(page, "report.pdf");
    await expectFileTabOpen(page, "report.pdf");

    const frame = page.getByTestId("pdf-file-preview").filter({ visible: true });
    await expect(frame).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
    // Chromium does not run its PDF viewer in a sandboxed frame.
    await expect(frame).not.toHaveAttribute("sandbox");
    const url = await frame.getAttribute("src");
    expect(await page.evaluate(async (src) => (await (await fetch(src!)).blob()).type, url)).toBe(
      "application/pdf",
    );
    await expect(page.getByText("Open .pdf files with", { exact: true })).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
