import type { KeyboardShortcutInput } from "../keyboard-shortcuts";

export interface KeyboardInputEvent extends KeyboardShortcutInput {
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface OverlayEntry {
  getLayer(): number;
  getKeys(): readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
  /** False for an entry that only claims its keys: it does not count as an open overlay for `hasBlocking`. */
  blocking?: boolean;
}
export function createOverlayRegistry() {
  const entries: OverlayEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function getTop(): OverlayEntry | undefined {
    return entries.reduce<OverlayEntry | undefined>(
      (top, entry) => (!top || entry.getLayer() >= top.getLayer() ? entry : top),
      undefined,
    );
  }
  return {
    getTop,
    getKeys: () => getTop()?.getKeys() ?? [],
    hasActive: () => entries.length > 0,
    hasBlocking: () => entries.some((entry) => entry.blocking !== false),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(entry: OverlayEntry) {
      entries.push(entry);
      notify();
      return () => {
        const index = entries.indexOf(entry);
        if (index < 0) return;
        entries.splice(index, 1);
        notify();
      };
    },
    dispatch(event: KeyboardInputEvent): boolean {
      if (event.isComposing || event.key === "Process") return false;
      if (!getTop()?.onKeyDown(event)) return false;
      event.stopPropagation();
      return true;
    },
  };
}
export const overlays = createOverlayRegistry();
