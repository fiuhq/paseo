import { afterEach, describe, expect, it, vi } from "vitest";
import { focusOwnsEscapeInside, listenForOutsideClick } from "./outside-click";

function element(attributes: Record<string, string> = {}, parent: Element = document.body) {
  const node = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  const child = document.createElement("span");
  node.appendChild(child);
  parent.appendChild(node);
  return child;
}

interface Point {
  x: number;
  y: number;
}

/** What the browser sends for a press at `down` released at `up`: the click lands on `clickTarget`. */
function press(downTarget: Element, clickTarget: Element, down: Point, up: Point = down) {
  downTarget.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: down.x, clientY: down.y }),
  );
  downTarget.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: up.x, clientY: up.y }),
  );
  clickTarget.dispatchEvent(
    new MouseEvent("click", { bubbles: true, clientX: up.x, clientY: up.y }),
  );
}

let detach: (() => void) | null = null;

afterEach(() => {
  detach?.();
  detach = null;
  document.body.replaceChildren();
});

function setup() {
  const flyout = document.createElement("div");
  document.body.appendChild(flyout);
  const close = vi.fn();
  detach = listenForOutsideClick(flyout, close);
  return { flyout, close };
}

describe("listenForOutsideClick", () => {
  it("closes on a click in place on the page outside the flyout", () => {
    const { close } = setup();
    const chat = element({ "data-testid": "agent-chat" });
    press(chat, chat, { x: 10, y: 10 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stays open for a click inside it, on its edge tab or header toggle, or in a menu it opened", () => {
    const { flyout, close } = setup();
    const overlayRoot = element({ id: "overlay-root" });
    const targets = [
      element({}, flyout),
      element({ "data-testid": "workspace-explorer-edge-handle" }),
      element({ "data-testid": "workspace-explorer-toggle" }),
      element({ role: "menuitem" }, overlayRoot),
    ];
    for (const target of targets) press(target, target, { x: 10, y: 10 });
    expect(close).not.toHaveBeenCalled();
  });

  it("stays open when a press inside it ends in a click on a common ancestor outside it", () => {
    const { flyout, close } = setup();
    press(element({}, flyout), document.body, { x: 10, y: 10 });
    expect(close).not.toHaveBeenCalled();
  });

  it("stays open when a press outside it is dragged past the click slop, as a tab dragged into it is", () => {
    const { close } = setup();
    const tab = element({ "data-testid": "workspace-tab" });
    press(tab, document.body, { x: 10, y: 10 }, { x: 30, y: 10 });
    expect(close).not.toHaveBeenCalled();
  });

  it("listens for nothing once detached", () => {
    const { close } = setup();
    detach?.();
    detach = null;
    const chat = element();
    press(chat, chat, { x: 10, y: 10 });
    expect(close).not.toHaveBeenCalled();
  });
});

describe("focusOwnsEscapeInside", () => {
  function focusable(tag: string, parent: Element, attributes: Record<string, string> = {}) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    parent.appendChild(node);
    return node as HTMLElement;
  }

  it("leaves Escape to a field focused inside the flyout and takes it everywhere else", () => {
    const flyout = document.createElement("div");
    const chat = document.createElement("div");
    document.body.append(flyout, chat);
    const cases: [HTMLElement, boolean][] = [
      [focusable("input", flyout), true],
      [focusable("textarea", focusable("div", flyout, { class: "xterm" })), true],
      [focusable("div", flyout, { contenteditable: "true", tabindex: "0" }), true],
      [focusable("button", flyout), false],
      [focusable("textarea", chat, { "data-testid": "message-input" }), false],
    ];
    for (const [node, owns] of cases) {
      node.focus();
      expect(document.activeElement).toBe(node);
      expect(focusOwnsEscapeInside(flyout)).toBe(owns);
    }
  });
});
