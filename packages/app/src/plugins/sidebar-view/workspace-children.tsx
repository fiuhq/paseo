import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  PluginSidebarViewProps,
  PluginSidebarWorkspaceChildrenProps,
} from "@getpaseo/plugin/client";
import { createContext, useCallback, useContext, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { densityIconBox } from "@/styles/density";
import { iconSizeFor } from "@/components/ui/control-geometry";
import { entityRefs } from "../client-state/refs";
import { PluginEnvironmentProvider } from "../popover";
import { SurfaceErrorBoundary } from "../surface-error-boundary";

type PluginEnvironment = Parameters<typeof PluginEnvironmentProvider>[0]["environment"];

interface WorkspaceChildrenView {
  installation: object;
  Component: ComponentType<PluginSidebarWorkspaceChildrenProps>;
  props: PluginSidebarViewProps;
  environment: PluginEnvironment;
}

const WorkspaceChildrenContext = createContext<WorkspaceChildrenView | null>(null);

/** Set by a sidebar view that keeps Paseo's sidebar; every workspace row then becomes expandable. */
export function SidebarWorkspaceChildrenProvider({
  value,
  children,
}: {
  value: WorkspaceChildrenView | null;
  children: ReactNode;
}) {
  return (
    <WorkspaceChildrenContext.Provider value={value}>{children}</WorkspaceChildrenContext.Provider>
  );
}

const ExpandedWorkspacesSchema = z.strictObject({ keys: z.array(z.string()) });

interface ExpandedWorkspacesState {
  keys: string[];
  toggle: (workspaceKey: string) => void;
}

/** Which workspace rows the user opened. Kept per device, like collapsed projects. */
const useExpandedWorkspaces = create<ExpandedWorkspacesState>()(
  persist<ExpandedWorkspacesState, [], [], z.infer<typeof ExpandedWorkspacesSchema>>(
    (set) => ({
      keys: [],
      toggle: (workspaceKey) =>
        set((state) => ({
          keys: state.keys.includes(workspaceKey)
            ? state.keys.filter((key) => key !== workspaceKey)
            : [...state.keys, workspaceKey],
        })),
    }),
    {
      name: "sidebar-expanded-workspaces",
      storage: createValidatedPersistStorage(AsyncStorage, ExpandedWorkspacesSchema),
      partialize: (state) => ({ keys: state.keys }),
    },
  ),
);

function useIsExpanded(workspaceKey: string): boolean {
  return useExpandedWorkspaces((state) => state.keys.includes(workspaceKey));
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/** Whether rows are expandable: a sidebar view with WorkspaceChildren is selected. */
export function useWorkspaceRowsExpandable(): boolean {
  return useContext(WorkspaceChildrenContext) !== null;
}

/** The row's expand control, drawn only while such a view is active. */
export function SidebarWorkspaceChevron({
  workspaceKey,
  onFocusChange,
}: {
  workspaceKey: string;
  /** Lets a row that shows the chevron only on hover also show it while it has keyboard focus. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const { t } = useTranslation();
  const view = useContext(WorkspaceChildrenContext);
  const expanded = useIsExpanded(workspaceKey);
  const toggle = useExpandedWorkspaces((state) => state.toggle);
  const onPress = useCallback(() => toggle(workspaceKey), [toggle, workspaceKey]);
  // A mouse click focuses the button too; only keyboard focus should keep it drawn.
  const onFocus = useCallback(
    (event: { target: unknown }) =>
      onFocusChange?.(
        !isWeb || (event.target instanceof Element && event.target.matches(":focus-visible")),
      ),
    [onFocusChange],
  );
  const onBlur = useCallback(() => onFocusChange?.(false), [onFocusChange]);
  if (!view) return null;
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <ToolbarButton
      label={expanded ? t("sidebar.view.collapseWorkspace") : t("sidebar.view.expandWorkspace")}
      compact
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      testID={`sidebar-workspace-expand-${workspaceKey}`}
      style={styles.chevron}
    >
      <Chevron size={14} uniProps={chevronColor} />
    </ToolbarButton>
  );
}

/** The plugin's section under an expanded row; a plugin failure stays inside it. */
export function SidebarWorkspaceChildren({
  serverId,
  workspaceId,
  workspaceKey,
}: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}) {
  const view = useContext(WorkspaceChildrenContext);
  const expanded = useIsExpanded(workspaceKey);
  const compact = useIsCompactFormFactor();
  if (!view || !expanded) return null;
  const { Component } = view;
  return (
    // On touch the row gives the chevron a column of its own and its leading slot grows to the
    // touch icon size, so the section moves right by both; a plugin indents from the pointer
    // layout's title offset in either layout.
    <View
      testID={`sidebar-workspace-children-${workspaceKey}`}
      style={isNative || compact ? styles.touchIndent : undefined}
    >
      <SurfaceErrorBoundary installation={view.installation} Surface={Component}>
        <PluginEnvironmentProvider environment={view.environment}>
          <Component {...view.props} workspace={entityRefs.workspace(serverId, workspaceId)} />
        </PluginEnvironmentProvider>
      </SurfaceErrorBoundary>
    </View>
  );
}

const leadingSlot = densityIconBox("md");
const pointerLeadingSlot = iconSizeFor("md").pointer;
const styles = StyleSheet.create((theme) => ({
  touchIndent: {
    // The chevron column and its gap, plus how much wider the leading slot is than on pointer.
    paddingLeft: {
      xs: 2 * leadingSlot.xs + theme.spacing[2] - pointerLeadingSlot,
      md: 2 * leadingSlot.md + theme.spacing[2] - pointerLeadingSlot,
    },
  },
  chevron: { width: 20, height: 20, padding: 0 },
}));
