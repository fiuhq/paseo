import { describe, expect, test } from "vitest";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  buildQuestionPreviewDocument,
  parseQuestionFormQuestions,
  previewedOptionIndex,
  questionAdvancesOnPick,
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
          question: "Ship it?",
          header: "Ship",
          options: [{ label: "Yes", preview: "   " }, { label: "No" }],
          multiSelect: false,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [layout, box, ship] = questions;
    expect(layout?.previewFormat).toBe("html");
    expect(layout?.options.map((option) => option.preview)).toEqual([
      "\n  <div>Cards</div>",
      "<div>List</div>",
    ]);
    // ASCII art and Markdown do not open with a tag.
    expect(box?.previewFormat).toBe("markdown");
    expect(box?.options.map((option) => option.preview)).toEqual(["+------+", undefined]);
    // A blank preview is no preview.
    expect(ship?.previewFormat).toBeUndefined();
    expect(ship?.options.map((option) => option.preview)).toEqual([undefined, undefined]);
  });

  test("previews the latest pick, or the first option before any pick", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          options: [
            { label: "Plain" },
            { label: "Cards", preview: "<div>Cards</div>" },
            { label: "List", preview: "<div>List</div>" },
          ],
          multiSelect: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    const [question] = questions;
    if (!question) throw new Error("question missing");
    expect(previewedOptionIndex(question, new Set())).toBeNull();
    expect(
      previewedOptionIndex(
        { ...question, options: [{ label: "Cards", preview: "<div>Cards</div>" }] },
        new Set(),
      ),
    ).toBe(0);
    expect(previewedOptionIndex(question, new Set([2]))).toBe(2);
    expect(previewedOptionIndex(question, new Set([2, 1]))).toBe(1);
    expect(previewedOptionIndex(question, new Set([0]))).toBeNull();
  });

  test("keeps a question with previews open after a pick so its options can be compared", () => {
    const questions = parseQuestionFormQuestions({
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          options: [{ label: "Cards", preview: "<div>Cards</div>" }, { label: "List" }],
          multiSelect: false,
        },
        {
          question: "Which provider?",
          header: "Provider",
          options: [{ label: "Claude" }, { label: "Codex" }],
          multiSelect: false,
        },
        {
          question: "Which fruits?",
          header: "Fruits",
          options: [{ label: "Apple" }, { label: "Pear" }],
          multiSelect: true,
        },
      ],
    });

    if (!questions) throw new Error("questions did not parse");
    expect(questions.map(questionAdvancesOnPick)).toEqual([false, true, false]);
    expect(previewedOptionIndex(questions[1] ?? questions[0], new Set())).toBeNull();
  });

  test("wraps an HTML preview in a document that runs nothing and loads nothing", () => {
    const document = buildQuestionPreviewDocument('<div style="padding:8px">Cards</div>');

    expect(document).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    );
    expect(document).toContain('<body><div style="padding:8px">Cards</div></body>');
  });
});
