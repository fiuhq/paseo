import { i18n } from "@/i18n/i18next";
import type { WorkspaceTitleState } from "@getpaseo/protocol/messages";

/** True while a plugin's judge has not passed a title, so the workspace shows no name yet. */
export function isWorkspaceTitleHeld(state: WorkspaceTitleState | null | undefined): boolean {
  return state != null && state.status !== "unchecked";
}

export function workspaceHeldTitleLabel(): string {
  return i18n.t("workspace.titleState.naming");
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
