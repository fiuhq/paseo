import { selectIsCompactFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import {
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { pluginRegistry } from "@/plugins/registry";
import {
  findExplorerDefaultPanel,
  withTabFirst,
} from "@/plugins/workspace-panels/explorer-default";
import {
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
} from "@/stores/workspace-layout-actions";
import { panelResourceKey } from "@/panels/panel-manifest";

export type ExplorerSidebarView = "changes" | "files" | "pr";
export type ExplorerSidebarPresentation = "overlay" | "dock" | "flyout";

const VIEW_TARGETS: Record<ExplorerSidebarView, WorkspaceTabTarget> = {
  changes: { kind: "changes_tree" },
  files: { kind: "files" },
  pr: { kind: "pull_request" },
};

export interface ExplorerSidebarQuery {
  isCompact: boolean;
  workspaceKey: string | null;
}

/**
 * Compact layouts swipe the Explorer in as an overlay. Wide layouts follow the user's setting: dock it beside the
 * workspace, taking its width, or fly it out over the workspace from the right edge (`dock` when no setting is given).
 */
export function resolveExplorerSidebarPresentation(
  input: Pick<ExplorerSidebarQuery, "isCompact"> & { preference?: "flyout" | "dock" },
): ExplorerSidebarPresentation {
  if (input.isCompact) {
    return "overlay";
  }
  return input.preference ?? "dock";
}

/** Reveals the Explorer sidebar and selects one of its navigation trees. */
export function openExplorerSidebarView(
  input: ExplorerSidebarQuery & { view: ExplorerSidebarView },
): void {
  if (!input.workspaceKey) return;
  const store = useWorkspaceLayoutStore.getState();
  const paneId = showExplorerSidebar(input);
  store.openTab({
    workspaceKey: input.workspaceKey,
    target: VIEW_TARGETS[input.view],
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
}

export function showExplorerSidebar(input: ExplorerSidebarQuery): string | null {
  if (input.isCompact) {
    usePanelStore.getState().showMobileFileExplorer();
  }
  if (input.workspaceKey) {
    const store = useWorkspaceLayoutStore.getState();
    const paneId = input.isCompact
      ? store.ensureExplorerSidebar(input.workspaceKey)
      : store.showExplorerSidebar(input.workspaceKey);
    if (paneId) revealExplorerDefaultTab(input.workspaceKey, paneId);
    return paneId;
  }
  return null;
}

/**
 * Every time the Explorer opens, the panel a plugin declared as its default (`explorerDefault`) is shown, as its first
 * tab. A caller that opens a particular view (Changes, Files, a pull request) reveals that view after this, so it wins.
 * A panel the user already opened in another pane stays there.
 */
function revealExplorerDefaultTab(workspaceKey: string, paneId: string): void {
  const serverId = workspaceKey.slice(0, workspaceKey.indexOf(":"));
  if (!serverId) return;
  const target = findExplorerDefaultPanel(pluginRegistry.getSnapshot(), serverId);
  if (!target) return;
  const store = useWorkspaceLayoutStore.getState();
  const current = store.layoutByWorkspace[workspaceKey];
  const key = panelResourceKey(target);
  const existing = current
    ? collectAllTabs(current.root).find((tab) => panelResourceKey(tab.target) === key)
    : undefined;
  if (current && existing && findPaneContainingTab(current.root, existing.tabId)?.id !== paneId) {
    return;
  }
  const tabId = store.openTab({
    workspaceKey,
    target,
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
  if (!tabId) return;
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const pane = layout ? findPaneById(layout.root, paneId) : null;
  if (pane && pane.tabIds[0] !== tabId && pane.tabIds.includes(tabId)) {
    store.reorderTabsInPane(workspaceKey, paneId, withTabFirst(pane.tabIds, tabId));
  }
}

export function hideExplorerSidebar(input: ExplorerSidebarQuery): void {
  if (input.isCompact) {
    usePanelStore.getState().showMobileAgent();
    return;
  }
  if (input.workspaceKey) {
    useWorkspaceLayoutStore.getState().hideExplorerSidebar(input.workspaceKey);
  }
}

export function toggleExplorerSidebar(input: ExplorerSidebarQuery): void {
  if (input.isCompact) {
    if (isExplorerSidebarOpen(input)) hideExplorerSidebar(input);
    else showExplorerSidebar(input);
    return;
  }
  if (!input.workspaceKey) return;
  if (isExplorerSidebarOpen(input)) {
    hideExplorerSidebar(input);
  } else {
    showExplorerSidebar(input);
  }
}

export function useIsExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
  const compactOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const paneOpen = useWorkspaceLayoutStore((state) =>
    input.workspaceKey ? selectIsExplorerSidebarVisible(state, input.workspaceKey) : false,
  );
  return input.isCompact ? compactOpen : paneOpen;
}

export function isExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
  if (input.isCompact) {
    return selectIsCompactFileExplorerOpen(usePanelStore.getState());
  }
  return Boolean(
    input.workspaceKey &&
    selectIsExplorerSidebarVisible(useWorkspaceLayoutStore.getState(), input.workspaceKey),
  );
}
