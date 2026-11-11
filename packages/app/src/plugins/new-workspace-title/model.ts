import type { InstalledPlugin, PluginNewWorkspaceTitleContribution } from "../types";

export interface NewWorkspaceTitle {
  plugin: InstalledPlugin;
  title: PluginNewWorkspaceTitleContribution;
}

/** The first title registered on the host, in plugin order, or `null` for the default title. */
export function firstNewWorkspaceTitle(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): NewWorkspaceTitle | null {
  for (const plugin of plugins) {
    const title = plugin.serverId === serverId ? plugin.newWorkspaceTitles[0] : undefined;
    if (title) return { plugin, title };
  }
  return null;
}
