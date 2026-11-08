/**
 * What a click may land on without closing the flyout: its edge tab and the header toggle, which toggle it themselves,
 * and the menus and dialogs it opens, which render outside its node.
 */
const KEEPS_OPEN =
  '[data-testid="workspace-explorer-edge-handle"], [data-testid="workspace-explorer-toggle"], [role="menu"], [role="dialog"], [role="listbox"], [role="tooltip"]';

/** Whether a click on `target` closes the Explorer flyout: one outside it, as a click outside Salesforce Inspector's panel does. */
export function clickClosesFlyout(target: Element, flyout: Element): boolean {
  return !flyout.contains(target) && target.closest(KEEPS_OPEN) === null;
}
