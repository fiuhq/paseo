import { type ReactNode, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { isWeb } from "@/constants/platform";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { useOverlayLayer } from "@/lib/overlay-root";
import { listenForOutsideClick } from "./outside-click";

/** How long the Explorer takes to slide in or out. */
const SLIDE_MS = 180;

interface ExplorerFlyoutProps {
  isOpen: boolean;
  /** Whether its workspace is the one on screen; a retained background workspace's flyout listens for nothing. */
  isWorkspaceActive: boolean;
  /** The Explorer's width, how far it slides. */
  width: number;
  /** Close it: Escape, or a click outside it on web. */
  onRequestClose(): void;
  /** Drawn on the flyout but outside its clipped body: the edge tab on its left edge. */
  attachment?: ReactNode;
  /** The Explorer itself, told whether it is on screen (true through the slide out). */
  children(shown: boolean): ReactNode;
}

/**
 * The Explorer as a flyout over the workspace on wide layouts, the way Salesforce Inspector's panel opens over the page:
 * it slides in from the right edge over the chat and takes no width from it, keeps its edge tab on its left edge, and
 * closes from that tab, Escape, or a click anywhere outside it (on web). It stays rendered until the slide out ends.
 */
export function ExplorerFlyout({
  isOpen,
  isWorkspaceActive,
  width,
  onRequestClose,
  attachment,
  children,
}: ExplorerFlyoutProps) {
  const [shown, setShown] = useState(isOpen);
  const progress = useSharedValue(isOpen ? 1 : 0);
  const nodeRef = useRef<View>(null);

  useEffect(() => {
    if (isOpen) setShown(true);
    progress.value = withTiming(isOpen ? 1 : 0, { duration: SLIDE_MS }, (finished) => {
      if (finished && !isOpen) scheduleOnRN(setShown, false);
    });
  }, [isOpen, progress]);

  const listening = isOpen && isWorkspaceActive;
  const layer = useOverlayLayer("floating");
  useOverlayRegistration({
    keys: ["Escape"],
    active: listening,
    layer,
    manageFocus: false,
    blocking: false,
    onKeyDown: (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onRequestClose();
      return true;
    },
  });

  useEffect(() => {
    if (!isWeb || !listening) return;
    const node: unknown = nodeRef.current;
    if (!(node instanceof HTMLElement)) return;
    return listenForOutsideClick(node, onRequestClose);
  }, [listening, onRequestClose]);

  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * (width + SHADOW_REACH) }],
    opacity: progress.value === 0 ? 0 : 1,
  }));

  return (
    <Animated.View
      ref={nodeRef}
      testID="workspace-explorer-flyout"
      pointerEvents={isOpen ? "auto" : "none"}
      style={[styles.flyout, !shown && styles.gone, slide]}
    >
      {children(shown)}
      {attachment}
    </Animated.View>
  );
}

/** How far the shadow reaches past the flyout's left edge, slid out with it. */
const SHADOW_REACH = 24;

const styles = StyleSheet.create({
  flyout: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    zIndex: 4,
    flexDirection: "row",
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: -4, height: 0 },
  },
  gone: { display: "none" },
});
