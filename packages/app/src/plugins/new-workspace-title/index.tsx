import { useCallback, useMemo, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { pluginThemeMapping, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { titleCallerFor } from "./caller";
import { firstNewWorkspaceTitle, type NewWorkspaceTitle } from "./model";

/**
 * The New workspace title: the host's first plugin title, or `children`, the default title. A
 * plugin title that renders nothing, or throws, shows the default.
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
    <ThemedNewWorkspaceTitleHost selected={selected} uniProps={pluginThemeMapping}>
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
  const renderDefault = useCallback(() => children, [children]);
  const Caller = titleCallerFor(title.Component);
  return (
    <PluginEnvironmentProvider environment={environment}>
      <SurfaceErrorBoundary
        installation={plugin}
        Surface={title.Component}
        renderError={renderDefault}
      >
        <Caller titleProps={props}>{children}</Caller>
      </SurfaceErrorBoundary>
    </PluginEnvironmentProvider>
  );
}

const ThemedNewWorkspaceTitleHost = withUnistyles(NewWorkspaceTitleHost);
