import { Fragment, useMemo, type ReactNode } from "react";
import { isWorkspaceTitleHeld } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CompactHeader } from "@/components/headers/compact-header";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import { WorkspaceTitleStateChip } from "@/screens/workspace/workspace-title-state-chip";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
} from "@/window-layout";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  isLoading: boolean;
  title: string;
  workspace: WorkspaceDescriptor | null | undefined;
  subtitle: string;
  isSubtitleDistinct: boolean;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  tabSwitcher: ReactNode;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full";
  actionsActive: boolean;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  workspace,
  subtitle,
  isSubtitleDistinct,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  tabSwitcher,
  serverId,
  headerVariant,
  actionsActive,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const subtitleRow = useMemo(
    () => (
      <View style={styles.subtitleRow}>
        <WorkspaceHeaderProjectRow
          subtitle={subtitle}
          isSubtitleDistinct={isSubtitleDistinct}
          serverId={serverId}
        />
        <WorkspaceTitleStateChip serverId={serverId} workspace={workspace} />
      </View>
    ),
    [subtitle, isSubtitleDistinct, serverId, workspace],
  );
  const symbols = {
    "tab-count": tabSwitcher,
    overflow: children,
    explorer: (
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    ),
  };
  const actions = resolveWorkspaceBarActions(headerVariant).map((symbol) => (
    <Fragment key={symbol}>{symbols[symbol]}</Fragment>
  ));

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          navigation="menu"
          title={title}
          titleTestID="workspace-header-title"
          titleMuted={isWorkspaceTitleHeld(workspace?.titleState)}
          subtitle={subtitleRow}
          loading={isLoading}
          actions={actionsInBar ? undefined : actions}
        />
      ) : null}
      <WindowLayoutActions active={actionsActive}>{actions}</WindowLayoutActions>
    </IconButtonChromeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The header row has one line left under the title, so the project and chip share it.
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    overflow: "hidden",
  },
}));
