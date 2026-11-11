import { Platform, type ViewStyle } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface KeyEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly target: unknown;
  preventDefault(): void;
}
declare const window: {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};

/**
 * The street is drawn with CSS 3D transforms on real DOM, so it stays readable and clickable by an
 * agent. React Native has no 3D rendering context, so phones get the 2D map only.
 * ponytail: web-only 3D; a native renderer (expo-gl) if the street is ever wanted on a phone.
 */
export const CAN_3D = Platform.OS === "web";

function typing(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  if ("isContentEditable" in target && target.isContentEditable === true) return true;
  return (
    "tagName" in target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}

function shown(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (!("getClientRects" in node) || typeof node.getClientRects !== "function") return false;
  const rects: unknown = node.getClientRects();
  return (
    typeof rects === "object" &&
    rects !== null &&
    "length" in rects &&
    typeof rects.length === "number" &&
    rects.length > 0
  );
}

/** Walk keys while the street is on screen. The handler returns true for a key it used. */
export function onKeys(
  root: { readonly current: unknown },
  handler: (key: string) => boolean,
): () => void {
  if (Platform.OS !== "web") return () => {};
  const listener = (event: KeyEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
    if (!shown(root.current)) return;
    if (handler(event.key)) event.preventDefault();
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

/** The viewport: the eye stands `perspective` px in front of the screen. */
export function viewport(perspective: number): ViewStyle {
  const style = {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
    perspective: `${perspective}px`,
  } as const;
  return style;
}

/** A zero-size origin at the viewport's centre whose children share one 3D space. */
export function space(transform: string, animate: boolean): ViewStyle {
  const style = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 0,
    height: 0,
    transformStyle: "preserve-3d",
    transform,
    transition: animate ? "transform 450ms cubic-bezier(0.2, 0.7, 0.2, 1)" : "none",
  } as const;
  return style;
}

/** A flat rectangle centred on a point in that space. */
export function plane(width: number, height: number, transform: string): ViewStyle {
  const style = {
    position: "absolute",
    left: -width / 2,
    top: -height / 2,
    width,
    height,
    transform,
    backfaceVisibility: "hidden",
  } as const;
  return style;
}
