/**
 * What a click may land on without closing the flyout: its edge tab and the header toggle, which toggle it themselves,
 * and the menus and dialogs it opens, which render outside its node.
 */
const KEEPS_OPEN =
  '[data-testid="workspace-explorer-edge-handle"], [data-testid="workspace-explorer-toggle"], [role="menu"], [role="dialog"], [role="listbox"], [role="tooltip"]';

/** How far the pointer may move between press and release and still count as a click rather than a drag. */
const CLICK_SLOP_PX = 4;

function isOutside(target: EventTarget | null, flyout: Element): boolean {
  return (
    target instanceof Element && !flyout.contains(target) && target.closest(KEEPS_OPEN) === null
  );
}

/**
 * Closes the Explorer flyout on a click outside it, as Salesforce Inspector's `outsidePopupClick` does. Only a press and
 * release in place outside it counts: a tab drag, an edge-tab or resize drag, or a text selection ends in a click on a
 * common ancestor, and none of them closes it. Listens in the capture phase, so a click a pane stops still closes it and
 * the click itself goes through. Returns the detach.
 */
export function listenForOutsideClick(flyout: Element, close: () => void): () => void {
  let press: { x: number; y: number; outside: boolean } | null = null;
  function onPointerDown(event: PointerEvent) {
    press = { x: event.clientX, y: event.clientY, outside: isOutside(event.target, flyout) };
  }
  function onPointerUp(event: PointerEvent) {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) {
      press.outside = false;
    }
  }
  function onClick(event: MouseEvent) {
    const pressed = press;
    press = null;
    if (pressed?.outside && isOutside(event.target, flyout)) close();
  }
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("click", onClick, true);
  };
}
