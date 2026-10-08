import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { page, userEvent } from "@vitest/browser/context";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";
import {
  buildQuestionPreviewDocument,
  QUESTION_PREVIEW_MESSAGE_MARKER,
  questionPreviewStateMessage,
} from "./question-form-card-core";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser with the real web `EditingTextInput`, because the bug under test lives in the
 * gap between that input and React state: the input owns its text and never replays state, so a
 * card that drops the Other text from state alone keeps showing it while submit ignores it.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function buildPermission(question: Record<string, unknown>): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [question] },
    },
  };
}

function mountCard(question: Record<string, unknown>) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QuestionFormCard
        permission={buildPermission(question)}
        onRespond={onRespond}
        isResponding={false}
      />,
    ),
  );
  mounted.push({ root, container });

  const view = within(container);
  const optionRole = question.multiSelect ? "checkbox" : "radio";
  const otherInput = () =>
    view.getByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  const check = (label: string) => act(() => view.getByRole(optionRole, { name: label }).click());
  const type = (text: string) => {
    const input = otherInput();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    act(() => {
      valueSetter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    });
  };
  const submit = () => act(() => view.getByRole("button", { name: "Submit" }).click());
  const submittedAnswers = (): Record<string, string> => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return (response.updatedInput as { answers: Record<string, string> }).answers;
  };
  return { check, type, otherInput, submit, submittedAnswers };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

describe("QuestionFormCard other answers", () => {
  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.check("Apple");
    card.check("Cherry");
    card.type("durian");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.type("durian");
    card.check("Apple");
    card.check("Banana");

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.type("OpenCode");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.type("OpenCode");
    card.check("Codex");

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});

describe("QuestionFormCard option previews", () => {
  const layoutQuestion = {
    question: "Which card layout?",
    header: "Layout",
    options: [
      { label: "Compact", description: "Title only", preview: "<div>Compact card</div>" },
      { label: "Detailed", description: "Title and chart", preview: "<div>Detailed card</div>" },
    ],
    multiSelect: false,
    allowOther: true,
  };
  const shipQuestion = {
    question: "Ship it now?",
    header: "Ship",
    options: [{ label: "Yes" }, { label: "No" }],
    multiSelect: false,
  };

  function mountQuestions(questions: Record<string, unknown>[]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const permission = buildPermission(questions[0] ?? {});
    permission.request.input = { questions };
    act(() =>
      root.render(
        <QuestionFormCard permission={permission} onRespond={vi.fn()} isResponding={false} />,
      ),
    );
    mounted.push({ root, container });
    const view = within(container);
    const pictureFrame = (label: string) => view.getByTitle<HTMLIFrameElement>(`Preview: ${label}`);
    const pictureViewport = (label: string) => {
      const viewport = pictureFrame(label).closest<HTMLElement>(
        '[data-testid="question-option-preview"]',
      );
      if (!viewport) throw new Error(`no preview viewport for ${label}`);
      return viewport;
    };
    // The box the picture is fitted into, and the frame as it is drawn (scaled) inside it.
    const pictureBox = (label: string) => pictureViewport(label).getBoundingClientRect();
    const drawnFrame = (label: string) => pictureFrame(label).getBoundingClientRect();
    const toolbarButton = (label: string, name: string) =>
      within(pictureViewport(label)).getByRole("button", { name });
    const currentQuestion = () => view.getByTestId("question-form-current-question").textContent;
    const pick = (label: string) => act(() => view.getByRole("radio", { name: label }).click());
    return {
      container,
      view,
      pictureFrame,
      pictureBox,
      drawnFrame,
      toolbarButton,
      currentQuestion,
      pick,
    };
  }

  it("shows every option's picture under its own option at once", () => {
    const card = mountQuestions([layoutQuestion]);

    for (const [label, body] of [
      ["Compact", "<div>Compact card</div>"],
      ["Detailed", "<div>Detailed card</div>"],
    ]) {
      const frame = card.pictureFrame(label);
      expect(frame.srcdoc).toContain(`<body>${body}</body>`);
      expect(frame.closest('[role="radio"]')?.getAttribute("aria-label")).toBe(label);
    }
  });

  it("moves on to the next question after a pick, as questions without pictures do", () => {
    const card = mountQuestions([layoutQuestion, shipQuestion]);

    card.pick("Detailed");

    expect(card.currentQuestion()).toBe("Ship it now?");
  });

  const widePicture = {
    ...layoutQuestion,
    options: [{ label: "Wide", preview: '<div style="width:600px;height:200px">Wide</div>' }],
  };

  it("fits a picture drawn wider than its option into it whole, laid out at its own width", async () => {
    const card = mountQuestions([widePicture]);
    card.container.style.width = "300px";

    await vi.waitFor(() => {
      const box = card.pictureBox("Wide");
      expect(box.width).toBeGreaterThan(0);
      expect(box.width).toBeLessThan(300);
      expect(box.width / box.height).toBeCloseTo(3, 1);
      expect(card.drawnFrame("Wide").width).toBeCloseTo(box.width, 0);
      expect(card.pictureFrame("Wide").offsetWidth).toBe(600);
    });
  });

  it("sizes the frame to a picture narrower than its option", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [{ label: "Small", preview: '<div style="width:200px;height:80px">Small</div>' }],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Small").width).toBe(200);
      expect(card.pictureBox("Small").height).toBe(80);
    });
  });

  it("fits a picture taller than the frame's limit into it instead of clipping it", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [{ label: "Tall", preview: '<div style="width:200px;height:720px">Tall</div>' }],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Tall").height).toBe(360);
      expect(card.pictureBox("Tall").width).toBe(100);
    });
  });

  it("measures a picture drawn by positioned content", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Positioned",
            preview:
              '<div style="position:relative;width:200px"><div style="position:absolute;width:200px;height:80px">Picture</div></div>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Positioned").height).toBe(80);
      expect(card.pictureBox("Positioned").width).toBe(200);
    });
  });

  it("measures a picture whose only content is absolutely positioned", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Absolute",
            preview:
              '<div style="position:absolute;left:0;top:0;width:200px;height:80px">Picture</div>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Absolute").height).toBe(80);
      expect(card.pictureBox("Absolute").width).toBe(200);
    });
  });

  it("measures positioned content drawn above and left of the page", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Negative",
            preview:
              '<div style="position:relative;width:200px;height:80px"><div style="position:absolute;left:-20px;top:-20px;width:240px;height:120px">x</div></div>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Negative").height).toBe(120);
      expect(card.pictureBox("Negative").width).toBe(240);
    });
  });

  it("measures text that overflows its positioned box", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Overflow",
            preview:
              '<div style="position:absolute;left:0;top:0;width:200px;height:20px;white-space:pre;font:16px/20px monospace">Line 1\nLine 2\nLine 3</div>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureBox("Overflow").height).toBeGreaterThanOrEqual(60);
      expect(card.pictureBox("Overflow").width).toBeGreaterThanOrEqual(200);
    });
  });

  it("grows the frame when a narrower container rewraps the preview text", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [{ label: "Prose", preview: `<p>${"wrapping words ".repeat(40)}</p>` }],
      },
    ]);
    card.container.style.width = "800px";
    await vi.waitFor(() => expect(card.pictureBox("Prose").height).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wide = card.pictureBox("Prose").height;

    card.container.style.width = "300px";

    await vi.waitFor(() => expect(card.pictureBox("Prose").height).toBeGreaterThan(wide));
  });

  it("draws the preview in a frame of its own origin where nothing can load", () => {
    const card = mountQuestions([layoutQuestion]);
    const frame = card.pictureFrame("Compact");

    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain(
      `content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"`,
    );
  });

  it("runs the picture's own scripts, so it can be clicked through without picking the option", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Live",
            preview: `<button onclick="this.textContent='Clicked'">Press</button>`,
          },
          { label: "Other" },
        ],
      },
      shipQuestion,
    ]);
    card.container.style.width = "800px";
    await vi.waitFor(() => expect(card.pictureBox("Live").height).toBeGreaterThan(0));
    const pressed = card.pictureBox("Live").width;
    const frame = page.frameLocator(page.elementLocator(card.pictureFrame("Live")));

    await frame.getByRole("button", { name: "Press" }).click();

    // The frame's page is out of the test's reach (its own origin); its new, wider label shows
    // as the picture growing.
    await vi.waitFor(() => expect(card.pictureBox("Live").width).toBeGreaterThan(pressed));
    expect(card.currentQuestion()).toBe("Which card layout?");
  });

  it("zooms the picture from its toolbar and back to the fitted size, without picking the option", async () => {
    const card = mountQuestions([widePicture, shipQuestion]);
    card.container.style.width = "300px";
    await vi.waitFor(() => expect(card.pictureBox("Wide").height).toBeGreaterThan(0));
    const fitted = card.pictureBox("Wide").width;
    await vi.waitFor(() => expect(card.drawnFrame("Wide").width).toBeCloseTo(fitted, 0));
    expect(card.toolbarButton("Wide", "Zoom out").getAttribute("aria-disabled")).toBe("true");

    act(() => card.toolbarButton("Wide", "Zoom in").click());

    await vi.waitFor(() => expect(card.drawnFrame("Wide").width).toBeCloseTo(fitted * 1.25, 0));
    expect(card.pictureBox("Wide").width).toBe(fitted);
    expect(card.currentQuestion()).toBe("Which card layout?");

    act(() => card.toolbarButton("Wide", "Reset view").click());

    await vi.waitFor(() => expect(card.drawnFrame("Wide").width).toBeCloseTo(fitted, 0));
  });

  it("pans a zoomed-in picture with the wheel, and leaves the wheel alone while it is fitted", async () => {
    const card = mountQuestions([widePicture]);
    card.container.style.width = "300px";
    await vi.waitFor(() => expect(card.pictureBox("Wide").height).toBeGreaterThan(0));
    const fitted = card.pictureBox("Wide").width;
    await vi.waitFor(() => expect(card.drawnFrame("Wide").width).toBeCloseTo(fitted, 0));
    const fittedLeft = card.drawnFrame("Wide").left;

    await userEvent.wheel(card.pictureFrame("Wide"), { delta: { x: 60 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(card.drawnFrame("Wide").left).toBe(fittedLeft);

    act(() => card.toolbarButton("Wide", "Zoom in").click());
    await vi.waitFor(() => expect(card.drawnFrame("Wide").width).toBeCloseTo(fitted * 1.25, 0));
    const zoomedLeft = card.drawnFrame("Wide").left;

    await userEvent.wheel(card.pictureFrame("Wide"), { delta: { x: 30 } });

    await vi.waitFor(() => expect(card.drawnFrame("Wide").left).toBeLessThan(zoomedLeft - 20));
  });

  it("gives a picture sized by its frame a height to be drawn at", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Viewport",
            preview: '<div style="width:600px;height:100vh;background:#09f"></div>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => expect(card.pictureBox("Viewport").height).toBeGreaterThan(0));
  });

  it("puts the picture back when its page navigates away once", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Leaves once",
            // The frame's name outlives its page: the first page leaves, the restored one stays
            // and draws itself taller, which only a page that runs again can report.
            preview:
              '<div id="picture" style="width:120px;height:40px">Picture</div><script>if (!window.name) { window.name = "left"; setTimeout(() => { location.href = "about:blank"; }, 20); } else { document.getElementById("picture").style.height = "60px"; }</script>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => expect(card.pictureBox("Leaves once").height).toBe(60));
    expect(
      card.view.queryByText("This preview tried to open another page, so it was stopped."),
    ).toBeNull();
  });

  it("stops a picture whose page keeps navigating away", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [
          {
            label: "Leaves",
            preview:
              '<div style="width:120px;height:40px">Picture</div><script>setTimeout(() => { location.href = "about:blank"; }, 20);</script>',
          },
        ],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() =>
      expect(
        card.view.getByText("This preview tried to open another page, so it was stopped."),
      ).toBeTruthy(),
    );
    expect(card.view.queryByTitle("Preview: Leaves")).toBeNull();
  });

  it("still moves on after a pick when the question has no previews", () => {
    const card = mountQuestions([shipQuestion, layoutQuestion]);

    expect(card.view.queryByTestId("question-form-option-picture")).toBeNull();
    card.pick("Yes");

    expect(card.currentQuestion()).toBe("Which card layout?");
  });
});

describe("question preview frame script", () => {
  const frames: HTMLIFrameElement[] = [];
  afterEach(() => {
    for (const frame of frames.splice(0)) frame.remove();
  });

  // The card's frame has an opaque origin; this one shares the test's origin only so the test can
  // dispatch input into it. The document and its script are the card's own.
  async function loadFrame(fragment: string) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.style.cssText = "width:400px;height:300px;border:0";
    const received: Record<string, unknown>[] = [];
    window.addEventListener("message", (event) => {
      if (event.source === frame.contentWindow && event.data?.[QUESTION_PREVIEW_MESSAGE_MARKER]) {
        received.push(event.data);
      }
    });
    const loaded = new Promise((resolve) =>
      frame.addEventListener("load", resolve, { once: true }),
    );
    frame.srcdoc = buildQuestionPreviewDocument(fragment);
    document.body.appendChild(frame);
    frames.push(frame);
    await loaded;
    // The frame's own event constructors, so dispatched input belongs to its realm.
    const win = frame.contentWindow as Window & typeof globalThis;
    const doc = frame.contentDocument!;
    const tell = (zoomed: boolean) => win.postMessage(questionPreviewStateMessage(zoomed), "*");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    return { win, doc, received, tell, settle };
  }

  it("reports the picture's size with the width of the frame it was laid out in", async () => {
    const frame = await loadFrame('<div style="width:600px;height:200px">Wide</div>');

    await vi.waitFor(() =>
      expect(frame.received).toContainEqual(
        expect.objectContaining({ type: "size", width: 600, height: 200, viewport: 400 }),
      ),
    );
  });

  it("forwards the wheel only while zoomed in, or with Ctrl/Cmd held", async () => {
    const frame = await loadFrame('<div style="width:600px;height:200px">Wide</div>');
    const wheel = (init: WheelEventInit) => {
      const event = new frame.win.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      frame.doc.body.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(wheel({ deltaY: 40 })).toBe(false);
    expect(wheel({ deltaY: 40, ctrlKey: true })).toBe(true);
    frame.tell(true);
    await frame.settle();
    expect(wheel({ deltaX: 25, deltaY: 10 })).toBe(true);
    await frame.settle();

    const wheels = frame.received.filter((message) => message.type === "wheel");
    expect(wheels).toEqual([
      expect.objectContaining({ zoom: true, deltaY: 40 }),
      expect.objectContaining({ zoom: false, deltaX: 25, deltaY: 10 }),
    ]);
  });

  it("turns a touch drag into a pan while zoomed in, and the drag does not click", async () => {
    const frame = await loadFrame(
      `<button style="width:300px;height:100px" onclick="window.clicked=true">Press</button>`,
    );
    frame.tell(true);
    await frame.settle();
    const button = frame.doc.querySelector("button")!;
    const pointer = (type: string, screenX: number) =>
      button.dispatchEvent(
        new frame.win.PointerEvent(type, {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          screenX,
          screenY: 50,
        }),
      );

    pointer("pointerdown", 100);
    pointer("pointermove", 130);
    pointer("pointerup", 130);
    button.dispatchEvent(new frame.win.MouseEvent("click", { bubbles: true, cancelable: true }));
    await frame.settle();

    expect(frame.received.filter((message) => message.type === "pan")).toEqual([
      expect.objectContaining({ dx: 30, dy: 0 }),
    ]);
    expect(Reflect.get(frame.win, "clicked")).toBeUndefined();
  });

  it("measures again when a click opens positioned content that leaves the body's box as it was", async () => {
    const frame = await loadFrame(
      `<div style="position:relative;width:200px;height:80px"><button onclick="document.getElementById('panel').style.display='block'">Open</button><div id="panel" style="display:none;position:absolute;left:0;top:60px;width:300px;height:200px"></div></div>`,
    );
    await vi.waitFor(() =>
      expect(frame.received).toContainEqual(
        expect.objectContaining({ type: "size", width: 200, height: 80 }),
      ),
    );

    frame.doc.querySelector("button")!.click();

    await vi.waitFor(() =>
      expect(frame.received).toContainEqual(
        expect.objectContaining({ type: "size", width: 300, height: 260 }),
      ),
    );
  });

  it("cancels a click on a link that would take the page away, and keeps links within the page", async () => {
    const frame = await loadFrame(
      '<a href="https://example.com/">Away</a> <a href="#here">Here</a>',
    );
    const click = (index: number) => {
      const event = new frame.win.MouseEvent("click", { bubbles: true, cancelable: true });
      frame.doc.querySelectorAll("a")[index]!.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(click(0)).toBe(true);
    expect(click(1)).toBe(false);
  });
});
