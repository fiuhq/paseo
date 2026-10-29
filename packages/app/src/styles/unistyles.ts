import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { hasFinePointer } from "@/hooks/use-fine-pointer";
import { REGISTERED_THEMES } from "./theme";

// `md` is both where sidebars dock beside the workspace and where desktop styles begin, so the
// docked shell never renders with compact styles. A mouse-driven window
// or a native app needs 720px, which fits the default 320px sidebar beside a 400px center. A touch
// browser (a tablet, an unfolded foldable) starts at 600px, which fits the 200px minimum sidebar
// beside the same center and is where Material's medium window class begins. Like the breakpoints,
// the pointer is read once at startup.
const DESKTOP_LAYOUT_MIN_WIDTH = isWeb && !hasFinePointer() ? 600 : 720;

StyleSheet.configure({
  themes: REGISTERED_THEMES,
  breakpoints: {
    xs: 0,
    sm: 576,
    md: DESKTOP_LAYOUT_MIN_WIDTH,
    lg: 992,
    xl: 1200,
  },
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
type AppThemes = typeof REGISTERED_THEMES;

interface AppBreakpoints {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}
