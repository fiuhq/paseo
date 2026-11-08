/**
 * Whether a press closes the Explorer flyout: one outside it, as a click outside Salesforce Inspector's panel closes it,
 * except on what keeps it open (its edge tab, which toggles it itself, and the menus and dialogs it opens, which render
 * outside its node).
 */
export function flyoutPressCloses(press: { insideFlyout: boolean; keepsOpen: boolean }): boolean {
  return !press.insideFlyout && !press.keepsOpen;
}
