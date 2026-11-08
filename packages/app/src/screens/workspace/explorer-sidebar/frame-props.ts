import type { ReactNode } from "react";
export interface ExplorerFrameProps {
  children: ReactNode;
  /** Compact layouts swipe the overlay; wide ones dock beside the workspace or fly out over it. */
  presentation: "overlay" | "dock" | "flyout";
  persistenceKey: string;
  containerWidth: number;
  isOpen: boolean;
  isWorkspaceActive: boolean;
  surfaceColor?: string;
  /** The flyout's close (Escape or a press outside it); required for `flyout`. */
  onRequestClose?: () => void;
  /** The flyout's edge tab, drawn on its left edge outside its clipped body. */
  attachment?: ReactNode;
}
