import { afterEach, describe, expect, it } from "vitest";
import { clickClosesFlyout } from "./outside-click";

function element(attributes: Record<string, string> = {}, parent: Element = document.body) {
  const node = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  const child = document.createElement("span");
  node.appendChild(child);
  parent.appendChild(node);
  return child;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("clickClosesFlyout", () => {
  it("closes only for a click on the page outside the flyout and what it owns", () => {
    const flyout = document.createElement("div");
    document.body.appendChild(flyout);
    const insideFlyout = element({}, flyout);
    const edgeTab = element({ "data-testid": "workspace-explorer-edge-handle" });
    const headerToggle = element({ "data-testid": "workspace-explorer-toggle" });
    const menu = element({ role: "menu" });
    const chat = element({ "data-testid": "agent-chat" });

    expect(clickClosesFlyout(insideFlyout, flyout)).toBe(false);
    expect(clickClosesFlyout(edgeTab, flyout)).toBe(false);
    expect(clickClosesFlyout(headerToggle, flyout)).toBe(false);
    expect(clickClosesFlyout(menu, flyout)).toBe(false);
    expect(clickClosesFlyout(chat, flyout)).toBe(true);
  });
});
