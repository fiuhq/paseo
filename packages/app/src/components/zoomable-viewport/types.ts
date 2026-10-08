import type { ComponentType, ReactNode, Ref } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { ViewportFitOptions, ViewportPoint, ViewportSize } from "./geometry";

export interface ZoomableViewportAction {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  testID?: string;
}

/**
 * Moves the viewport from input the canvas never sees: content that swallows its own pointer and
 * wheel events, such as an iframe, forwards them here.
 */
export interface ZoomableViewportHandle {
  /** Pan by a distance in screen pixels. */
  panBy: (delta: ViewportPoint) => void;
  /** Zoom by a factor around a point measured from the viewport's top-left corner. */
  zoomBy: (factor: number, point: ViewportPoint) => void;
}

export interface ZoomableViewportProps {
  contentSize: ViewportSize;
  children: ReactNode;
  actions?: ZoomableViewportAction[];
  accessibilityLabel?: string;
  fit?: ViewportFitOptions;
  maxScale?: number;
  minScale?: number;
  onPressOutsideContent?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  wheelActivation?: "always" | "modifier";
  /**
   * `hover` shows the zoom controls while the pointer or focus is in the viewport, `always` keeps
   * them up, `hidden` leaves them out (Ctrl/⌘ and the wheel, and a pinch, still zoom).
   */
  toolbarVisibility?: "hover" | "always" | "hidden";
  /** Which corner the zoom controls sit in, on the right edge. */
  toolbarPlacement?: "top" | "bottom";
  /** Called with the scale relative to the fitted size (1 is fitted) whenever it changes. */
  onScaleChange?: (scale: number) => void;
  ref?: Ref<ZoomableViewportHandle>;
}
