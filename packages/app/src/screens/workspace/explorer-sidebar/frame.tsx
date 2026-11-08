import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  FileExplorerCloseGestureContext,
  useCloseFileExplorerGesture,
} from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { ExplorerFlyout } from "./flyout";
import { useExplorerGeometry } from "./geometry";
import type { ExplorerFrameProps } from "./frame-props";

function ExplorerFrameBase({
  children,
  surfaceColor,
  presentation,
  isOpen,
  isWorkspaceActive,
  persistenceKey,
  containerWidth,
  onRequestClose,
  attachment,
}: ExplorerFrameProps) {
  const overlay = presentation === "overlay";
  const flyout = presentation === "flyout";
  const settledOpen = useIsMobilePanelActive("file-explorer");
  const active = isWorkspaceActive && (overlay ? settledOpen : isOpen);
  const resizeEnabled = isWorkspaceActive && !overlay && isOpen;
  const { gesture, gestureRef } = useCloseFileExplorerGesture(isWorkspaceActive && overlay);
  const storedWidth = useWorkspaceLayoutStore(
    (state) => state.explorerSidebarWidthByWorkspace[persistenceKey],
  );
  const resize = useWorkspaceLayoutStore((state) => state.resizeExplorerSidebar);
  const onResize = useCallback(
    (width: number) => resize(persistenceKey, width),
    [persistenceKey, resize],
  );
  const width = resolveExplorerSidebarWidth({ requestedWidth: storedWidth, containerWidth });
  const geometry = useExplorerGeometry({
    width,
    containerWidth,
    overlay,
    resizeEnabled,
    onResize,
  });
  const body = (shown: boolean) => (
    <RetainedPanelActivity active={active}>
      <FileExplorerCloseGestureContext value={gestureRef}>
        <MobilePanelOverlay
          panel="file-explorer"
          closeGesture={gesture}
          presentation={overlay ? "overlay" : "dock"}
          dockVisible={shown}
          frameStyle={geometry.frameStyle}
          panelStyle={[{ backgroundColor: surfaceColor }, geometry.panelStyle]}
        >
          <View style={styles.content}>
            {resizeEnabled ? geometry.resizeHandle : null}
            {children}
          </View>
        </MobilePanelOverlay>
      </FileExplorerCloseGestureContext>
    </RetainedPanelActivity>
  );
  if (!flyout) return body(isOpen);
  return (
    <ExplorerFlyout
      isOpen={isOpen}
      width={width}
      onRequestClose={onRequestClose ?? noop}
      attachment={attachment}
    >
      {body}
    </ExplorerFlyout>
  );
}

function noop() {}
export const ExplorerFrame = withUnistyles(ExplorerFrameBase, (theme) => ({
  surfaceColor: theme.colors.surfaceSidebar,
}));
const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } });
