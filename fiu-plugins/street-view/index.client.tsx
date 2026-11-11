import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { StreetView } from "./client/screen";

function StreetViewItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Map"
      active={currentScreen?.screenId === "city"}
      onPress={() => openScreen({ screenId: "city" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "city", title: "Street View", Component: StreetView });
  client.addSidebarHeaderItem({ id: "city", title: "Street View", Component: StreetViewItem });
  return () => {};
}
