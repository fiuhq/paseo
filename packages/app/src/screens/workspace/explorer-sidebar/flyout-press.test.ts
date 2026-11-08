import { describe, expect, it } from "vitest";
import { flyoutPressCloses } from "./flyout-press";

describe("flyoutPressCloses", () => {
  it("closes on a press outside the flyout, as a click outside Salesforce Inspector's panel does", () => {
    expect(flyoutPressCloses({ insideFlyout: false, keepsOpen: false })).toBe(true);
  });
  it("stays open for a press inside it, on its edge tab, or in a menu or dialog it opened", () => {
    expect(flyoutPressCloses({ insideFlyout: true, keepsOpen: false })).toBe(false);
    expect(flyoutPressCloses({ insideFlyout: false, keepsOpen: true })).toBe(false);
  });
});
