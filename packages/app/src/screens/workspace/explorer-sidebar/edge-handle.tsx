import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, PanResponder, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useExplorerEdgeHandleStore } from "@/stores/explorer-edge-handle-store";
import {
  dragEdgeHandleOffset,
  EDGE_HANDLE_DRAG_SLOP,
  EDGE_HANDLE_HEIGHT,
  edgeHandleTop,
} from "./edge-handle-geometry";

interface ExplorerEdgeHandleProps {
  isOpen: boolean;
  onToggle(): void;
  iconColor: string;
}

/**
 * A tab on the workspace column's right edge that slides the Explorer sidebar open (‹) and closed (›),
 * in the shape of Salesforce Inspector's arrow. It sits on the window edge while the Explorer is
 * hidden and on the Explorer's border while it shows. Drag it up or down to move it; the place is
 * kept on this device. Pressing it is the same toggle as Cmd+E and the header button.
 *
 * Hover follows docs/hover.md: a plain View tracks the pointer, an inner PressHighlight takes the press,
 * and the parent claims the gesture only once a press moves vertically, so a tap still toggles.
 */
function ExplorerEdgeHandleBase({ isOpen, onToggle, iconColor }: ExplorerEdgeHandleProps) {
  const { t } = useTranslation();
  const offset = useExplorerEdgeHandleStore((state) => state.offset);
  const setOffset = useExplorerEdgeHandleStore((state) => state.setOffset);
  const [height, setHeight] = useState(0);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const dragStart = useRef(offset);
  const heightRef = useRef(0);
  heightRef.current = height;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dy) > EDGE_HANDLE_DRAG_SLOP &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          dragStart.current = offsetRef.current;
        },
        onPanResponderMove: (_event, gesture) => {
          setDragOffset(dragEdgeHandleOffset(dragStart.current, gesture.dy, heightRef.current));
        },
        onPanResponderRelease: (_event, gesture) => {
          setOffset(dragEdgeHandleOffset(dragStart.current, gesture.dy, heightRef.current));
          setDragOffset(null);
        },
        onPanResponderTerminate: () => setDragOffset(null),
      }),
    [setOffset],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
  }, []);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const label = isOpen
    ? t("workspace.tabs.explorerSidebar.close")
    : t("workspace.tabs.explorerSidebar.open");
  const Chevron = isOpen ? ChevronRight : ChevronLeft;
  const top = edgeHandleTop(dragOffset ?? offset, height);
  const placement = useMemo(() => [styles.hoverTarget, { top }], [top]);
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);
  const active = hovered || dragOffset !== null;
  const tabStyle = useMemo(() => [styles.tab, active ? styles.tabActive : null], [active]);

  return (
    <View pointerEvents="box-none" style={styles.rail} onLayout={handleLayout}>
      {height > 0 ? (
        <View
          style={placement}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          {...responder.panHandlers}
        >
          <PressHighlight
            testID="workspace-explorer-edge-handle"
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={accessibilityState}
            onPress={onToggle}
            style={tabStyle}
            highlightStyle={styles.tabActive}
          >
            <Chevron size={14} color={iconColor} />
          </PressHighlight>
        </View>
      ) : null}
    </View>
  );
}

export const ExplorerEdgeHandle = withUnistyles(ExplorerEdgeHandleBase, (theme) => ({
  iconColor: theme.colors.foregroundMuted,
}));

const styles = StyleSheet.create((theme) => ({
  rail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 16,
    zIndex: 3,
  },
  hoverTarget: {
    position: "absolute",
    right: 0,
  },
  tab: {
    width: 16,
    height: EDGE_HANDLE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
    opacity: 0.6,
  },
  tabActive: {
    opacity: 1,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
}));
