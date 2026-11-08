import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BetterSidebar } from "./client/tree";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addSidebarView !== "function") {
    throw new Error("better-sidebar needs a Paseo build with sidebar views (getpaseo/paseo#8906)");
  }
  return client.addSidebarView({
    id: "tree",
    title: "Better sidebar",
    description: "Projects, then workspaces you can expand to see every agent inside",
    Component: BetterSidebar,
  });
}
