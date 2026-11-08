import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

const explorerDefault = vi.hoisted(() => ({
  target: null as PluginWorkspaceTabTarget | null,
}));
vi.mock("@/plugins/workspace-panels/explorer-default", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/plugins/workspace-panels/explorer-default")>()),
  findExplorerDefaultPanel: () => explorerDefault.target,
}));

import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";

const WORKSPACE_KEY = "server-1:ws-main";

beforeEach(() => {
  explorerDefault.target = null;
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
  });
});

describe("Explorer sidebar", () => {
  it("selects the Explorer shell from the form factor", () => {
    expect(resolveExplorerSidebarPresentation({ isCompact: true })).toBe("overlay");
    expect(resolveExplorerSidebarPresentation({ isCompact: false })).toBe("dock");
    expect(resolveExplorerSidebarPresentation({ isCompact: false, preference: "flyout" })).toBe(
      "flyout",
    );
    expect(resolveExplorerSidebarPresentation({ isCompact: true, preference: "flyout" })).toBe(
      "overlay",
    );
  });

  it("uses the same Explorer pane inside the compact overlay", () => {
    openExplorerSidebarView({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      view: "changes",
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const pane = findPaneById(layout.root, selectExplorerSidebarPaneId(state, WORKSPACE_KEY)!);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === pane?.focusedTabId)?.target.kind,
    ).toBe("changes_tree");
  });

  it("creates a dedicated desktop Explorer containing only its requested tree", () => {
    openExplorerSidebarView({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      view: "files",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const paneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    expect(paneId).not.toBeNull();
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).toContain("files");
  });

  it("toggles the desktop Explorer independently of ordinary panes", () => {
    const input = {
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
    };
    openExplorerSidebarView({ ...input, view: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    const openedState = useWorkspaceLayoutStore.getState();
    const openedLayout = openedState.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(openedState, WORKSPACE_KEY);
    const explorerPane =
      openedLayout && explorerPaneId ? findPaneById(openedLayout.root, explorerPaneId) : null;
    const activeExplorerTarget =
      openedLayout && explorerPane
        ? collectAllTabs(openedLayout.root).find((tab) => tab.tabId === explorerPane.focusedTabId)
            ?.target.kind
        : null;
    expect(activeExplorerTarget).toBe("files");
  });

  it("toggles the compact Explorer without changing its selected view", () => {
    const input = {
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
    };

    toggleExplorerSidebar(input);

    expect(isExplorerSidebarOpen(input)).toBe(true);
  });

  describe("with a plugin panel declared as the Explorer's default", () => {
    const panel: PluginWorkspaceTabTarget = {
      kind: "plugin",
      pluginId: "fiu-cli",
      panelId: "storyboard",
      context: "workspace",
    };
    const input = { isCompact: false, workspaceKey: WORKSPACE_KEY };

    function paneOf(kind: "plugin") {
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      const tab = collectAllTabs(layout.root).find((candidate) => candidate.target.kind === kind);
      return tab ? findPaneContainingTab(layout.root, tab.tabId) : null;
    }

    it("opens it first and selected in the Explorer each time the Explorer opens", () => {
      explorerDefault.target = panel;
      openExplorerSidebarView({ ...input, view: "files" });
      toggleExplorerSidebar(input);
      toggleExplorerSidebar(input);

      const state = useWorkspaceLayoutStore.getState();
      const explorerPaneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
      const pane = paneOf("plugin");
      expect(pane?.id).toBe(explorerPaneId);
      expect(pane?.tabIds[0]).toBe(pane?.focusedTabId);
    });

    it("leaves it in the pane where the user opened it outside the Explorer", () => {
      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey: WORKSPACE_KEY,
        target: panel,
        intent: "reveal",
        placement: { mode: "focused" },
      });
      const mainPaneId = paneOf("plugin")?.id;
      explorerDefault.target = panel;

      toggleExplorerSidebar(input);

      const state = useWorkspaceLayoutStore.getState();
      expect(isExplorerSidebarOpen(input)).toBe(true);
      expect(mainPaneId).toBeDefined();
      expect(paneOf("plugin")?.id).toBe(mainPaneId);
      expect(paneOf("plugin")?.id).not.toBe(selectExplorerSidebarPaneId(state, WORKSPACE_KEY));
    });
  });
});
