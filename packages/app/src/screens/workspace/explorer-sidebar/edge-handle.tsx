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
  isClickAfterDrag,
} from "./edge-handle-geometry";

/** The side of its parent the tab is pinned to. */
type ExplorerEdgeHandleEdge = "left" | "right";

interface ExplorerEdgeHandleProps {
  isOpen: boolean;
  /** Right: the workspace column's edge. Left: the open compact Explorer's edge. Defaults to right. */
  edge?: ExplorerEdgeHandleEdge;
  /**
   * Render only while the Explorer is in this state. A compact layout carries one tab per state,
   * each on the surface that is on screen then; a wide layout's one tab serves both.
   */
  shownWhen?: "open" | "closed";
  onToggle(): void;
  iconColor: string;
}

/**
 * A tab that slides the Explorer sidebar open (‹) and closed (›), in the shape of Salesforce
 * Inspector's arrow. On wide layouts it sits on the workspace column's right edge: the window edge
 * while the Explorer is hidden, the Explorer's border while it shows. On compact layouts, where the
 * Explorer covers the screen, the workspace column carries it on its right edge and the open
 * Explorer on its left. Drag it up or down to move it; the place is kept on this device and shared
 * by every edge. Pressing it is the same toggle as Cmd+E and the header button.
 *
 * Hover follows docs/hover.md: a plain View tracks the pointer, an inner PressHighlight takes the press,
 * and the parent claims the gesture only once a press moves vertically, so a tap still toggles.
 */
function ExplorerEdgeHandleBase({
  isOpen,
  edge = "right",
  onToggle,
  iconColor,
}: ExplorerEdgeHandleProps) {
  const left = edge === "left";
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
  const dragEndedAt = useRef<number | null>(null);

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
          dragEndedAt.current = Date.now();
        },
        onPanResponderTerminate: () => setDragOffset(null),
      }),
    [setOffset],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeight(event.nativeEvent.layout.height);
  }, []);
  const handlePress = useCallback(() => {
    if (isClickAfterDrag(dragEndedAt.current, Date.now())) return;
    onToggle();
  }, [onToggle]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);

  const label = isOpen
    ? t("workspace.tabs.explorerSidebar.close")
    : t("workspace.tabs.explorerSidebar.open");
  const Chevron = isOpen ? ChevronRight : ChevronLeft;
  const top = edgeHandleTop(dragOffset ?? offset, height);
  const rail = useMemo(() => [styles.rail, left ? styles.pinLeft : styles.pinRight], [left]);
  const placement = useMemo(
    () => [styles.hoverTarget, left ? styles.pinLeft : styles.pinRight, { top }],
    [left, top],
  );
  const active = hovered || dragOffset !== null;
  const tabStyle = useMemo(
    () => [
      styles.tab,
      left ? styles.tabOnLeft : styles.tabOnRight,
      active ? styles.tabActive : null,
    ],
    [left, active],
  );

  return (
    <View pointerEvents="box-none" style={rail} onLayout={handleLayout}>
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
            aria-expanded={isOpen}
            onPress={handlePress}
            hitSlop={HIT_SLOP}
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

const ExplorerEdgeHandleTab = withUnistyles(ExplorerEdgeHandleBase, (theme) => ({
  iconColor: theme.colors.foregroundMuted,
}));

/**
 * The tab, or nothing while the Explorer is not in `shownWhen`. Hiding unmounts the tab, so a hover
 * that began before a click (the pointer never leaves a tab that disappears) does not come back with it.
 */
export function ExplorerEdgeHandle({
  shownWhen,
  ...props
}: Omit<ExplorerEdgeHandleProps, "iconColor">) {
  if (shownWhen && (shownWhen === "open") !== props.isOpen) return null;
  return <ExplorerEdgeHandleTab {...props} />;
}

/**
 * A finger needs more than the 16×48-point tab, so the press area reaches 12 points out on each
 * side and 8 above and below (40×64). Toward the edge the extra reach falls off the screen, or onto
 * the docked Explorer on wide layouts. Inward it covers a 12×64-point band of the content beside
 * the tab, and above and below it takes touches from the content there.
 */
const HIT_SLOP = { top: 8, bottom: 8, left: 12, right: 12 } as const;

const styles = StyleSheet.create((theme) => ({
  rail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 16,
    zIndex: 3,
  },
  hoverTarget: {
    position: "absolute",
  },
  pinRight: { right: 0 },
  pinLeft: { left: 0 },
  tab: {
    width: 16,
    height: EDGE_HANDLE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
    opacity: 0.6,
  },
  tabOnRight: {
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    borderRightWidth: 0,
  },
  tabOnLeft: {
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    borderLeftWidth: 0,
  },
  tabActive: {
    opacity: 1,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
}));
