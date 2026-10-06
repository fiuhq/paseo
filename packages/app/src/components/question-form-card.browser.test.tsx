import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

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
    const currentQuestion = () => view.getByTestId("question-form-current-question").textContent;
    const pick = (label: string) => act(() => view.getByRole("radio", { name: label }).click());
    return { container, view, pictureFrame, currentQuestion, pick };
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

  it("scales a picture drawn wider than its option down to fit", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [{ label: "Wide", preview: '<div style="width:600px;height:200px">Wide</div>' }],
      },
    ]);
    card.container.style.width = "300px";

    await vi.waitFor(() => {
      const zoom = Number(card.pictureFrame("Wide").contentDocument?.documentElement.style.zoom);
      expect(zoom).toBeGreaterThan(0);
      expect(zoom).toBeLessThan(1);
    });
    await vi.waitFor(() => expect(card.pictureFrame("Wide").offsetHeight).toBeLessThan(200));
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
      expect(card.pictureFrame("Small").offsetWidth).toBe(200);
      expect(card.pictureFrame("Small").offsetHeight).toBe(80);
    });
  });

  it("scales a picture taller than the frame's limit down instead of clipping it", async () => {
    const card = mountQuestions([
      {
        ...layoutQuestion,
        options: [{ label: "Tall", preview: '<div style="width:200px;height:720px">Tall</div>' }],
      },
    ]);
    card.container.style.width = "800px";

    await vi.waitFor(() => {
      expect(card.pictureFrame("Tall").offsetHeight).toBe(360);
      expect(card.pictureFrame("Tall").offsetWidth).toBe(100);
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
      expect(card.pictureFrame("Positioned").offsetHeight).toBe(80);
      expect(card.pictureFrame("Positioned").offsetWidth).toBe(200);
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
      expect(card.pictureFrame("Absolute").offsetHeight).toBe(80);
      expect(card.pictureFrame("Absolute").offsetWidth).toBe(200);
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
      expect(card.pictureFrame("Negative").offsetHeight).toBe(120);
      expect(card.pictureFrame("Negative").offsetWidth).toBe(240);
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
      expect(card.pictureFrame("Overflow").offsetHeight).toBeGreaterThanOrEqual(60);
      expect(card.pictureFrame("Overflow").offsetWidth).toBeGreaterThanOrEqual(200);
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
    await vi.waitFor(() => expect(card.pictureFrame("Prose").offsetHeight).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wide = card.pictureFrame("Prose").offsetHeight;

    card.container.style.width = "300px";

    await vi.waitFor(() => expect(card.pictureFrame("Prose").offsetHeight).toBeGreaterThan(wide));
  });

  it("draws the preview in a frame where no script can run and nothing can load", () => {
    const card = mountQuestions([layoutQuestion]);
    const frame = card.pictureFrame("Compact");

    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.srcdoc).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`,
    );
  });

  it("still moves on after a pick when the question has no previews", () => {
    const card = mountQuestions([shipQuestion, layoutQuestion]);

    expect(card.view.queryByTestId("question-form-option-picture")).toBeNull();
    card.pick("Yes");

    expect(card.currentQuestion()).toBe("Which card layout?");
  });
});
