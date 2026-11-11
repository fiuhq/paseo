import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { pluginThemeMapping, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { firstNewWorkspaceTitle, type NewWorkspaceTitle } from "./model";

function renderNothing() {
  return null;
}

/**
 * The New workspace title: the host's first plugin title, or `children`, the default title. A
 * plugin title that draws nothing, or throws, shows the default; React cannot tell a null render
 * apart, so the host reads the plugin title's measured height instead.
 */
export function PluginNewWorkspaceTitle({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const installed = useInstalledPlugins();
  const selected = useMemo(
    () => firstNewWorkspaceTitle(installed, serverId),
    [installed, serverId],
  );
  if (!selected) return children;
  return (
    <ThemedNewWorkspaceTitleHost
      key={`${selected.plugin.id}\n${selected.title.id}`}
      selected={selected}
      uniProps={pluginThemeMapping}
    >
      {children}
    </ThemedNewWorkspaceTitleHost>
  );
}

function NewWorkspaceTitleHost({
  selected: { plugin, title },
  theme,
  children,
}: {
  selected: NewWorkspaceTitle;
  theme: PluginHostProps["theme"];
  children: ReactNode;
}) {
  const { environment, props } = usePluginItemHost(plugin, theme);
  const [drawn, setDrawn] = useState(false);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setDrawn(event.nativeEvent.layout.height > 0),
    [],
  );
  const { Component } = title;
  return (
    <>
      <View onLayout={handleLayout} testID="plugin-new-workspace-title">
        <PluginEnvironmentProvider environment={environment}>
          <SurfaceErrorBoundary
            installation={plugin}
            Surface={Component}
            renderError={renderNothing}
          >
            <Component {...props} />
          </SurfaceErrorBoundary>
        </PluginEnvironmentProvider>
      </View>
      {drawn ? null : children}
    </>
  );
}

const ThemedNewWorkspaceTitleHost = withUnistyles(NewWorkspaceTitleHost);
