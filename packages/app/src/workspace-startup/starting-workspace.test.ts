import { describe, expect, it } from "vitest";
import { buildStartingWorkspace, mintWorkspaceId } from "./starting-workspace";

const project = {
  projectId: "prj_1",
  projectDisplayName: "fiuhq/core",
  projectCustomName: null,
  projectRootPath: "/repo/core",
  projectKind: "git",
} as const;
const at = new Date("2026-11-06T00:00:00Z");

describe("starting workspace", () => {
  it("mints an id the daemon accepts", () => {
    expect(mintWorkspaceId()).toMatch(/^wks_[a-f0-9]{16}$/);
    expect(mintWorkspaceId()).not.toBe(mintWorkspaceId());
  });

  it("is a running workspace with no folder yet", () => {
    const workspace = buildStartingWorkspace({
      id: "wks_1",
      project,
      worktreeSlug: "nice-bear",
      createsWorktree: true,
      prompt: "ayo",
      at,
    });
    expect(workspace).toMatchObject({
      id: "wks_1",
      projectId: "prj_1",
      projectDisplayName: "fiuhq/core",
      workspaceDirectory: "",
      workspaceKind: "worktree",
      worktreeSlug: "nice-bear",
      name: "ayo",
      status: "running",
      statusEnteredAt: at,
      isStarting: true,
    });
  });

  it("names itself from the first line of the prompt, or its slug when there is none", () => {
    const named = (prompt: string) =>
      buildStartingWorkspace({
        id: "wks_1",
        project,
        worktreeSlug: "nice-bear",
        createsWorktree: true,
        prompt,
        at,
      }).name;
    expect(named("  Fix the replay test\nand then more")).toBe("Fix the replay test");
    expect(named("   ")).toBe("nice-bear");
  });

  it("marks a local workspace as a directory and carries no slug", () => {
    const workspace = buildStartingWorkspace({
      id: "wks_1",
      project,
      worktreeSlug: "nice-bear",
      createsWorktree: false,
      prompt: "ayo",
      at,
    });
    expect(workspace.workspaceKind).toBe("directory");
    expect(workspace.worktreeSlug).toBeUndefined();
  });
});
