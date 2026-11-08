import { i18n } from "@/i18n/i18next";
import type { WorkspaceTitleState } from "@getpaseo/protocol/messages";

export function workspaceHeldTitleLabel(): string {
  return i18n.t("workspace.titleState.naming");
}

/**
 * The label a workspace goes by: "Naming…" only while the title gate is still working on it. Once the
 * gate has given up (`no-reply`, `exhausted`) nothing more will name it, so the workspace's own name shows
 * and the header chip says why, with Rename.
 */
export function workspaceTitleLabel(workspace: {
  name: string;
  titleState?: WorkspaceTitleState | null;
}): string {
  const status = workspace.titleState?.status;
  return status === "naming" || status === "refused" ? workspaceHeldTitleLabel() : workspace.name;
}

/** What the header says about the title, and whether the user has to step in. */
export function describeWorkspaceTitleState(
  state: WorkspaceTitleState | null | undefined,
): { text: string; canRename: boolean } | null {
  switch (state?.status) {
    case "refused":
      return {
        text: i18n.t("workspace.titleState.refused", {
          title: state.refusedTitle ?? "",
          score: state.score === null ? "?" : state.score.toFixed(2),
        }),
        canRename: false,
      };
    case "no-reply":
      return { text: i18n.t("workspace.titleState.noReply"), canRename: true };
    case "exhausted":
      return {
        text: i18n.t("workspace.titleState.exhausted", { tries: state.attempts }),
        canRename: true,
      };
    case "unchecked":
      return {
        text: i18n.t("workspace.titleState.unchecked", {
          judge: state.judge ?? i18n.t("workspace.titleState.judgeFallback"),
        }),
        canRename: false,
      };
    default:
      return null;
  }
}
