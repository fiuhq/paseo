import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import type { InstalledPlugin } from "../types";

/**
 * The Explorer's default tab on a host: the first installed workspace panel that declares `explorerDefault`, as the tab
 * target the Explorer opens. Null when no panel asks, so the Explorer keeps whatever tab it last showed.
 */
export function findExplorerDefaultPanel(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): PluginWorkspaceTabTarget | null {
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    const panel = plugin.workspacePanels.find(
      (candidate) =>
        candidate.explorerDefault === true &&
        candidate.context === "workspace" &&
        candidate.locations.includes("explorer"),
    );
    if (panel)
      return { kind: "plugin", pluginId: plugin.id, panelId: panel.id, context: "workspace" };
  }
  return null;
}

/** A pane's tab order with `tabId` first and the rest kept in their order. */
export function withTabFirst(tabIds: readonly string[], tabId: string): string[] {
  return [tabId, ...tabIds.filter((id) => id !== tabId)];
}
