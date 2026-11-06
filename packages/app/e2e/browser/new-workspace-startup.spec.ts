import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { expectRememberedModel } from "../support/helpers/model-memory";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  gateBrowserCreationPhases,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
  waitForCreatedWorkspace,
} from "../support/helpers/new-workspace";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

test.describe("New workspace startup", () => {
  test.describe.configure({ timeout: 240_000 });

  async function openComposer(page: import("@playwright/test").Page, repoPath: string) {
    const client = await connectNewWorkspaceDaemonClient();
    const project = await openProjectViaDaemon(client, repoPath);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: project.projectKey,
      projectDisplayName: project.projectDisplayName,
    });
    // Create refuses with "Select a model" until the provider list has resolved the saved model.
    await expectRememberedModel(page, "Ten second stream", { timeout: 30_000 });
    return { client, project };
  }

  test("shows what is starting from Enter, queues behind the first message, and reports the times", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("workspace-startup-");
    const gate = await gateBrowserCreationPhases(page);
    const { client, project } = await openComposer(page, repo.path);
    try {
      await selectWorkspaceIsolation(page, "worktree");
      await submitNewWorkspacePrompt(page, "First message");
      await gate.waitForCreateRequest();

      const checklist = page.getByTestId("workspace-startup-checklist").filter({ visible: true });
      // Nothing has come back from the daemon yet: the gate holds every phase past accepted.
      await expect(page).toHaveURL(/\/workspace\/wks_[a-f0-9]{16}/, { timeout: 30_000 });
      const startedId = /wks_[a-f0-9]{16}/.exec(page.url())?.[0] ?? "";
      await expect(checklist).toBeVisible({ timeout: 30_000 });
      await expect(checklist.getByTestId("workspace-startup-step-workspace")).toContainText(
        "Creating worktree",
      );
      await expect(
        page
          .getByTestId("user-message")
          .filter({ hasText: "First message" })
          .filter({ visible: true }),
      ).toBeVisible();
      const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${startedId}`);
      await expect(row).toContainText("First message");
      await expect(row).toContainText("setting up");

      // Leaving and coming back lands on the same screen, still starting.
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: project.workspaceId,
      });
      await expect(checklist).toHaveCount(0);
      await page.getByTestId("sidebar-global-new-workspace").click();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue("");
      await row.click();
      await expect(page).toHaveURL(new RegExp(startedId));
      await expect(checklist).toBeVisible({ timeout: 30_000 });

      await expect(checklist.getByTestId("workspace-startup-step-agent")).toHaveAttribute(
        "aria-valuetext",
        "waiting",
      );

      gate.releaseWorkspace();
      const created = await waitForCreatedWorkspace(client, new Set([project.workspaceId]));
      expect(created.id).toBe(startedId);
      await expect(checklist.getByTestId("workspace-startup-step-workspace")).toHaveAttribute(
        "aria-valuetext",
        "done",
        { timeout: 30_000 },
      );
      await expect(checklist.getByTestId("workspace-startup-step-agent")).toHaveAttribute(
        "aria-valuetext",
        "running",
      );

      const composer = page
        .getByPlaceholder("Add more — it queues behind your first message")
        .filter({ visible: true });
      await expect(composer).toBeFocused();
      await composer.fill("Second message");
      await composer.press("Enter");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue("");
      await expect(page.getByText("Second message").filter({ visible: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
      await composer.fill("Typed but not sent");

      gate.releaseAgent();
      await expect(
        page.getByTestId("workspace-startup-summary").filter({ visible: true }),
      ).toContainText(/Ready in .+ · worktree .+/, { timeout: 30_000 });
      await expect(checklist).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }),
      ).toHaveValue("Typed but not sent");
      await expect(
        page
          .getByTestId("user-message")
          .filter({ hasText: "Second message" })
          .filter({ visible: true }),
      ).toBeVisible({ timeout: 60_000 });

      if (created.workspaceDirectory) {
        await archiveWorkspaceFromDaemon(client, created.workspaceDirectory).catch(() => undefined);
      }
    } finally {
      gate.releaseAgent();
      await archiveLocalWorkspaceFromDaemon(client, project.workspaceId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("puts the first message ahead of typed text when the agent fails to start", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("workspace-startup-agent-fail-");
    const gate = await gateBrowserCreationPhases(page);
    const { client, project } = await openComposer(page, repo.path);
    try {
      await selectWorkspaceIsolation(page, "worktree");
      await submitNewWorkspacePrompt(page, "First message");
      await gate.waitForCreateRequest();

      gate.releaseWorkspace();
      const created = await waitForCreatedWorkspace(client, new Set([project.workspaceId]));
      await expect(page).toHaveURL(new RegExp(created.id), { timeout: 30_000 });

      const composer = page
        .getByPlaceholder("Add more — it queues behind your first message")
        .filter({ visible: true });
      await composer.fill("Typed since");
      gate.failCreation("Unable to start agent");

      await expect(
        page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }),
      ).toHaveValue("First message\n\nTyped since", { timeout: 30_000 });

      if (created.workspaceDirectory) {
        await archiveWorkspaceFromDaemon(client, created.workspaceDirectory).catch(() => undefined);
      }
    } finally {
      gate.releaseAgent();
      await archiveLocalWorkspaceFromDaemon(client, project.workspaceId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("puts a failed prompt ahead of text typed on the next New workspace", async ({ page }) => {
    const repo = await createTempGitRepo("workspace-startup-typed-since-");
    const gate = await gateBrowserCreationPhases(page, { keepFromDaemon: true });
    const { client, project } = await openComposer(page, repo.path);
    try {
      await selectWorkspaceIsolation(page, "worktree");
      await submitNewWorkspacePrompt(page, "This one fails");
      await gate.waitForCreateRequest();
      await expect(page).toHaveURL(/\/workspace\/wks_/, { timeout: 30_000 });

      await page.getByTestId("sidebar-global-new-workspace").click();
      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toHaveValue("");
      await composer.fill("Typed since");

      gate.failCreation("Unable to create worktree");

      await expect(composer).toHaveValue("This one fails\n\nTyped since", { timeout: 30_000 });
      await expect(page.getByTestId("workspace-startup-failure")).toHaveText(
        "Unable to create worktree",
      );
    } finally {
      gate.releaseAgent();
      await archiveLocalWorkspaceFromDaemon(client, project.workspaceId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("puts the fields back and keeps the error visible when creation fails", async ({ page }) => {
    const repo = await createTempGitRepo("workspace-startup-fail-");
    const gate = await gateBrowserCreationPhases(page, { keepFromDaemon: true });
    const { client, project } = await openComposer(page, repo.path);
    try {
      await selectWorkspaceIsolation(page, "worktree");
      await submitNewWorkspacePrompt(page, "This one fails");
      await gate.waitForCreateRequest();
      const checklist = page.getByTestId("workspace-startup-checklist").filter({ visible: true });
      await expect(checklist).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/workspace\/wks_/, { timeout: 30_000 });
      const startedId = /wks_[a-f0-9]{16}/.exec(page.url())?.[0] ?? "";

      gate.failCreation("Unable to create worktree");

      await expect(page).toHaveURL(/\/new/, { timeout: 30_000 });
      await expect(checklist).toHaveCount(0, { timeout: 30_000 });
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${startedId}`),
      ).toHaveCount(0);
      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible();
      await expect(page.getByTestId("workspace-startup-failure")).toHaveText(
        "Unable to create worktree",
      );
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveValue(
        "This one fails",
      );
    } finally {
      gate.releaseAgent();
      await archiveLocalWorkspaceFromDaemon(client, project.workspaceId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });
});
