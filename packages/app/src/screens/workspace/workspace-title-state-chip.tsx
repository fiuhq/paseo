import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { WorkspaceRenameModal } from "@/workspace-rename";
import { describeWorkspaceTitleState } from "@/utils/workspace-title-state";

/** Says why a workspace has no title yet, or that its title went on unchecked. */
export function WorkspaceTitleStateChip({
  serverId,
  workspace,
}: {
  serverId: string;
  workspace: WorkspaceDescriptor | null | undefined;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const openRename = useCallback(() => setRenaming(true), []);
  const closeRename = useCallback(() => setRenaming(false), []);
  const description = describeWorkspaceTitleState(workspace?.titleState);
  const renameTarget = useMemo(
    () =>
      workspace
        ? { serverId, workspaceId: workspace.id, name: workspace.name, title: workspace.title }
        : null,
    [serverId, workspace],
  );
  if (!description) return null;
  return (
    <View
      style={styles.chip}
      testID="workspace-title-state"
      accessibilityRole="text"
      accessibilityLabel={description.text}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text} numberOfLines={1}>
        {description.text}
      </Text>
      {description.canRename && renameTarget ? (
        <>
          <Button variant="ghost" size="sm" onPress={openRename} testID="workspace-title-rename">
            {t("workspace.titleState.rename")}
          </Button>
          <WorkspaceRenameModal visible={renaming} workspace={renameTarget} onClose={closeRename} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
