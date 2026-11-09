import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkfloorSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "workfloor",
    title: "Workfloor",
    icon: "MessagesSquare",
    Component: WorkfloorSettings,
  });
  client.addCommandCenterItem({
    id: "connect",
    title: "Connect Workfloor",
    icon: "MessagesSquare",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("workfloor");
    },
  });
  return () => {};
}
