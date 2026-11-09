import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeCardPills } from "./client/card-pill";
import { WorkfloorSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "workfloor",
    title: "Workfloor",
    icon: "MessagesSquare",
    Component: WorkfloorSettings,
  });
  return contributeCardPills(client);
}
