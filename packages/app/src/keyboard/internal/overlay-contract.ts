import type { RefObject } from "react";
import type { KeyboardInputEvent } from "./overlays";
export interface OverlayRegistration {
  active: boolean;
  layer: number;
  keys: readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
  restoreFocusRef?: RefObject<unknown>;
  manageFocus?: boolean;
  /** False when it only claims its keys and leaves other shortcuts, such as find, running. Defaults to true. */
  blocking?: boolean;
}
