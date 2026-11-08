import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkspaceAgents } from "./client/workspace-agents";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addSidebarView !== "function") {
    throw new Error("fiu.Better Sidebar needs a Paseo build with sidebar views");
  }
  return client.addSidebarView({
    id: "tree",
    title: "fiu.Better Sidebar",
    description: "Paseo's sidebar, with each workspace expandable to show the agents inside it",
    WorkspaceChildren: WorkspaceAgents,
  });
}
