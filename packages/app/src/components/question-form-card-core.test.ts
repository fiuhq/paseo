import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  buildQuestionPreviewDocument,
  measureQuestionPreviewLayout,
  parseQuestionFormQuestions,
  startQuestionPreviewLayout,
  QUESTION_PREVIEW_MESSAGE_MARKER,
  questionPreviewBox,
  questionPreviewStateMessage,
  readQuestionPreviewFrameMessage,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question-form-card-core";

describe("question form card core", () => {
  test("treats optional input prompts as skippable empty answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Optional comment?",
          header: "Response",
          options: [],
          multiSelect: false,
          placeholder: "Optional comment (press Enter to skip)...",
          allowEmpty: true,
          dismissLabel: "Skip",
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(areQuestionsAnswered(questions, {}, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, {})).toEqual({ Response: "" });
    expect(shouldSubmitEmptyOnDismiss(questions)).toBe(true);
    expect(resolveDismissLabel(questions)).toBe("Skip");
  });

  test("requires a selection for option-only questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick one",
          header: "Response",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(false);
    expect(areQuestionsAnswered(questions, {}, { 0: "freeform" })).toBe(false);
    expect(areQuestionsAnswered(questions, { 0: new Set([1]) }, {})).toBe(true);
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Response: "B",
    });
  });

  test("keeps checked options and appends the other answer for multi-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which fruits do you like?",
          header: "Fruits",
          options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
          multiSelect: true,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, { 0: " durian " })).toEqual({
      Fruits: "Apple, Cherry, durian",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([0, 2]) }, {})).toEqual({
      Fruits: "Apple, Cherry",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set() }, { 0: "durian" })).toEqual({
      Fruits: "durian",
    });
    expect(buildQuestionFormAnswers(questions, {}, { 0: "durian" })).toEqual({ Fruits: "durian" });
  });

  test("replaces the selected option with the other answer for single-select", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which provider?",
          header: "Provider",
          options: [{ label: "Claude Code" }, { label: "Codex" }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, { 0: "OpenCode" })).toEqual({
      Provider: "OpenCode",
    });
    expect(buildQuestionFormAnswers(questions, { 0: new Set([1]) }, {})).toEqual({
      Provider: "Codex",
    });
  });

  test("shows text input for explicit other questions", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          isOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("shows text input for questions that allow other answers", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Pick or type",
          header: "Response",
          options: [{ label: "A" }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(questionShowsTextInput(question)).toBe(true);
    expect(areQuestionsAnswered(questions, {}, { 0: "custom" })).toBe(true);
    expect(buildQuestionFormAnswers(questions, {}, { 0: "custom" })).toEqual({
      Response: "custom",
    });
  });

  test("reads option previews and tells HTML from Markdown by their content", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          options: [
            { label: "Cards", preview: "\n  <div>Cards</div>" },
            { label: "List", preview: "<div>List</div>" },
          ],
          multiSelect: false,
        },
        {
          question: "Which box?",
          header: "Box",
          options: [{ label: "Wide", preview: "+------+" }, { label: "Narrow" }],
          multiSelect: false,
        },
        {
          question: "Which latency?",
          header: "Latency",
          options: [{ label: "Fast", preview: "< 10 ms\n+-----+\n| API |\n+-----+" }],
          multiSelect: false,
        },
        {
          question: "Which style?",
          header: "Style",
          options: [
            { label: "Padded", preview: '<div style="padding:8px">Cards</div>' },
            { label: "Inline", preview: "<span>x</span>" },
          ],
          multiSelect: false,
        },
        {
          question: "Ship it?",
          header: "Ship",
          options: [{ label: "Yes", preview: "   " }, { label: "No" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [layout, box, latency, style, ship] = questions;
    expect(layout?.previewFormat).toBe("html");
    expect(layout?.options.map((option) => option.preview)).toEqual([
      "\n  <div>Cards</div>",
      "<div>List</div>",
    ]);
    // ASCII art and Markdown do not open with a tag.
    expect(box?.previewFormat).toBe("markdown");
    expect(box?.options.map((option) => option.preview)).toEqual(["+------+", undefined]);
    expect(latency?.previewFormat).toBe("markdown");
    expect(style?.previewFormat).toBe("html");
    // A blank preview is no preview.
    expect(ship?.previewFormat).toBeUndefined();
    expect(ship?.options.map((option) => option.preview)).toEqual([undefined, undefined]);
  });

  test("wraps an HTML preview in a document that runs its own scripts and loads nothing", () => {
    const document = buildQuestionPreviewDocument('<div style="padding:8px">Cards</div>');

    expect(document).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    );
    expect(document).toContain('<body><div style="padding:8px">Cards</div></body>');
    // The card's own script runs before anything the picture brings.
    expect(document.indexOf("<script>")).toBeLessThan(document.indexOf("<body>"));
  });

  test("reads only well-formed preview frame messages", () => {
    const marked = (message: Record<string, unknown>) => ({
      [QUESTION_PREVIEW_MESSAGE_MARKER]: true,
      ...message,
    });

    expect(
      readQuestionPreviewFrameMessage(
        marked({ type: "size", width: 600, height: 200, frameWidth: 400, frameHeight: 360 }),
      ),
    ).toEqual({ type: "size", width: 600, height: 200, frameWidth: 400, frameHeight: 360 });
    expect(
      readQuestionPreviewFrameMessage(
        marked({ type: "wheel", deltaX: 1, deltaY: -2, zoom: true, x: 3, y: 4 }),
      ),
    ).toEqual({ type: "wheel", deltaX: 1, deltaY: -2, zoom: true, x: 3, y: 4 });
    expect(readQuestionPreviewFrameMessage(marked({ type: "pan", dx: 5, dy: 6 }))).toEqual({
      type: "pan",
      dx: 5,
      dy: 6,
    });
    expect(
      readQuestionPreviewFrameMessage({
        type: "size",
        width: 600,
        height: 200,
        frameWidth: 400,
        frameHeight: 360,
      }),
    ).toBeNull();
    expect(
      readQuestionPreviewFrameMessage(
        marked({ type: "size", width: 0, height: 200, frameWidth: 400, frameHeight: 360 }),
      ),
    ).toBeNull();
    expect(
      readQuestionPreviewFrameMessage(
        marked({ type: "size", width: 600, height: 200, frameWidth: 400 }),
      ),
    ).toBeNull();
    expect(readQuestionPreviewFrameMessage(marked({ type: "pan", dx: "5", dy: 6 }))).toBeNull();
    expect(readQuestionPreviewFrameMessage(marked({ type: "state", zoomed: true }))).toBeNull();
    expect(readQuestionPreviewFrameMessage("size")).toBeNull();
  });

  test("tells the frame whether the picture is zoomed in", () => {
    expect(questionPreviewStateMessage(true)).toEqual({
      [QUESTION_PREVIEW_MESSAGE_MARKER]: true,
      type: "state",
      zoomed: true,
    });
  });

  test("fits a picture to its option's width and the height limit, never enlarging it", () => {
    expect(questionPreviewBox({ width: 200, height: 80 }, 800)).toEqual({ width: 200, height: 80 });
    expect(questionPreviewBox({ width: 600, height: 200 }, 300)).toEqual({
      width: 300,
      height: 100,
    });
    expect(questionPreviewBox({ width: 200, height: 720 }, 800)).toEqual({
      width: 100,
      height: 360,
    });
    expect(questionPreviewBox({ width: 1506, height: 955 }, 700)).toEqual({
      width: 568,
      height: 360,
    });
  });
});

// Lays a picture out the way its frame would draw it: `measure` is the page, sized by the frame
// it is laid out in; each step measures in the frame the layout asks for, as the card does.
function settle(
  room: number,
  measure: (frame: { width: number; height: number }) => { width: number; height: number },
) {
  let layout = startQuestionPreviewLayout("doc", room);
  let resizes = 0;
  for (let step = 0; step < 10; step += 1) {
    const next = measureQuestionPreviewLayout(layout, measure(layout.frame), layout.frame);
    if (JSON.stringify(next.frame) !== JSON.stringify(layout.frame)) resizes += 1;
    const same = JSON.stringify(next) === JSON.stringify(layout);
    layout = next;
    if (same) break;
  }
  return { layout, resizes };
}

describe("question preview layout", () => {
  test("lays a fixed picture out at its own size, once", () => {
    const { layout, resizes } = settle(700, () => ({ width: 1500, height: 955 }));
    expect(layout.frame).toEqual({ width: 1500, height: 955 });
    expect(layout.picture).toEqual({ width: 1500, height: 955 });
    expect(resizes).toBe(1);
  });

  test("keeps a picture smaller than the frame in the frame it started in", () => {
    const { layout, resizes } = settle(700, () => ({ width: 200, height: 80 }));
    expect(layout.frame).toEqual({ width: 700, height: 360 });
    expect(layout.picture).toEqual({ width: 200, height: 80 });
    expect(resizes).toBe(0);
  });

  test("does not shrink the frame of a picture sized by half its height", () => {
    const { layout } = settle(700, (frame) => ({ width: 600, height: frame.height / 2 }));
    expect(layout.frame.height).toBe(360);
    expect(layout.picture).toEqual({ width: 600, height: 180 });
  });

  test("stops following a picture that grows with its frame", () => {
    const tall = settle(700, (frame) => ({ width: 600, height: frame.height + 20 }));
    expect(tall.resizes).toBe(1);
    expect(tall.layout.settled).toBe(true);
    expect(tall.layout.picture).toEqual({ width: 600, height: tall.layout.frame.height });

    const wide = settle(700, (frame) => ({ width: frame.width * 1.2, height: 100 }));
    expect(wide.resizes).toBe(1);
    expect(wide.layout.picture?.width).toBe(wide.layout.frame.width);
  });

  test("ignores a measurement taken in a frame it has since resized", () => {
    const layout = startQuestionPreviewLayout("doc", 700);

    expect(
      measureQuestionPreviewLayout(layout, { width: 50, height: 50 }, { width: 300, height: 360 }),
    ).toBe(layout);
  });

  test("follows a picture that grows later, when a click opens a panel", () => {
    let { layout } = settle(700, () => ({ width: 600, height: 400 }));
    layout = measureQuestionPreviewLayout(layout, { width: 600, height: 700 }, layout.frame);

    expect(layout.frame).toEqual({ width: 700, height: 700 });
  });
});
