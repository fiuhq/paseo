// Where the Explorer edge handle sits on the workspace's right edge. The handle is a tab the user can
// drag up and down, as Salesforce Inspector's arrow is; its place is a fraction of the column height,
// so it stays put across window sizes.

export const EDGE_HANDLE_HEIGHT = 48;
export const EDGE_HANDLE_DEFAULT_OFFSET = 0.5;
/** How far a press must move before it is a drag rather than a tap. */
export const EDGE_HANDLE_DRAG_SLOP = 4;

/** How long after a drag ends a click is the drag's own release, not a tap. */
export const EDGE_HANDLE_CLICK_AFTER_DRAG_MS = 300;

const MIN_OFFSET = 0.05;
const MAX_OFFSET = 0.95;

/** A stored or dragged offset, kept on the column; anything unreadable is the default. */
export function clampEdgeHandleOffset(offset: number): number {
  if (!Number.isFinite(offset)) return EDGE_HANDLE_DEFAULT_OFFSET;
  return Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, offset));
}

/** The offset after dragging `dy` points from `start` on a column `height` points tall. */
export function dragEdgeHandleOffset(start: number, dy: number, height: number): number {
  if (!(height > 0)) return clampEdgeHandleOffset(start);
  return clampEdgeHandleOffset(start + dy / height);
}

/** The handle's top edge on a column `height` points tall: centred on the offset, never cut off. */
export function edgeHandleTop(offset: number, height: number): number {
  const top = clampEdgeHandleOffset(offset) * height - EDGE_HANDLE_HEIGHT / 2;
  return Math.max(0, Math.min(Math.max(0, height - EDGE_HANDLE_HEIGHT), top));
}

/**
 * Whether a press is the click a drag ends with. On web the browser still clicks the tab when a
 * drag lets go over it, so a press that soon after a drag is ignored; a real tap comes later.
 */
export function isClickAfterDrag(dragEndedAt: number | null, now: number): boolean {
  return (
    dragEndedAt !== null &&
    now - dragEndedAt >= 0 &&
    now - dragEndedAt < EDGE_HANDLE_CLICK_AFTER_DRAG_MS
  );
}
