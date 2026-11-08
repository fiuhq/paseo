import { describe, expect, test } from "vitest";
import { isWorkspaceTitleHeld, type WorkspaceTitleState } from "@getpaseo/protocol/messages";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { resolveWorkspaceHeader } from "@/screens/workspace/workspace-header-source";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { describeWorkspaceTitleState, workspaceHeldTitleLabel } from "./workspace-title-state";

const state = (overrides: Partial<WorkspaceTitleState>): WorkspaceTitleState => ({
  status: "naming",
  attempts: 0,
  refusedTitle: null,
  score: null,
  judge: null,
  ...overrides,
});

describe("workspace title state", () => {
  test("every state but unchecked holds the title back", () => {
    expect(isWorkspaceTitleHeld(null)).toBe(false);
    expect(isWorkspaceTitleHeld(undefined)).toBe(false);
    for (const status of ["naming", "refused", "no-reply", "exhausted"] as const) {
      expect(isWorkspaceTitleHeld(state({ status }))).toBe(true);
    }
    expect(isWorkspaceTitleHeld(state({ status: "unchecked" }))).toBe(false);
  });

  test("the header states read as designed", () => {
    expect(describeWorkspaceTitleState(state({}))).toBeNull();
    expect(describeWorkspaceTitleState(null)).toBeNull();
    expect(
      describeWorkspaceTitleState(
        state({ status: "refused", refusedTitle: "Register Slack issue triage", score: 0.42 }),
      ),
    ).toEqual({
      text: 'Refused "Register Slack issue triage" (0.42): waiting for the agent',
      canRename: false,
    });
    expect(describeWorkspaceTitleState(state({ status: "no-reply" }))).toEqual({
      text: "No title yet: the agent never replied",
      canRename: true,
    });
    expect(describeWorkspaceTitleState(state({ status: "exhausted", attempts: 3 }))).toEqual({
      text: "No title yet: 3 tries refused",
      canRename: true,
    });
    expect(describeWorkspaceTitleState(state({ status: "unchecked", judge: "Jev" }))).toEqual({
      text: "Not checked: Jev unreachable",
      canRename: false,
    });
  });

  test("a held workspace shows Naming in the sidebar and the header, never its derived name", () => {
    const held = { name: "wretched-wombat", currentBranch: null, titleState: state({}) };

    expect(
      resolveSidebarWorkspacePrimaryLabel({ workspace: held, workspaceTitleSource: "title" }),
    ).toBe(workspaceHeldTitleLabel());
    expect(
      resolveWorkspaceHeader({ workspace: held as unknown as WorkspaceDescriptor }).title,
    ).toBe(workspaceHeldTitleLabel());
    expect(workspaceHeldTitleLabel()).toBe("Naming…");
  });

  test("a workspace the gate is still naming reads Naming, one it gave up on reads its own name", () => {
    // A prompt with no task ("ayo") had all three candidates refused: the gate stopped, so "Naming…"
    // promised a title that never comes.
    const label = (titleState: WorkspaceTitleState) => {
      const workspace = { name: "gifted-pug", currentBranch: null, titleState };
      return {
        sidebar: resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource: "title" }),
        header: resolveWorkspaceHeader({ workspace: workspace as unknown as WorkspaceDescriptor })
          .title,
      };
    };
    const naming = { sidebar: "Naming…", header: "Naming…" };
    const ownName = { sidebar: "gifted-pug", header: "gifted-pug" };

    expect(label(state({ status: "naming" }))).toEqual(naming);
    expect(label(state({ status: "refused", attempts: 1, refusedTitle: "Say hi" }))).toEqual(
      naming,
    );
    expect(label(state({ status: "exhausted", attempts: 3 }))).toEqual(ownName);
    expect(label(state({ status: "no-reply" }))).toEqual(ownName);
  });

  test("someone who titles rows by branch still sees the branch", () => {
    expect(
      resolveSidebarWorkspacePrimaryLabel({
        workspace: { name: "x", currentBranch: "wretched-wombat", titleState: state({}) },
        workspaceTitleSource: "branch",
      }),
    ).toBe("wretched-wombat");
  });
});
