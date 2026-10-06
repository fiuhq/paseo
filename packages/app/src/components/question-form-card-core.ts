/**
 * How an option's `preview` is written. Claude's AskUserQuestion writes Markdown/ASCII by default and
 * an HTML fragment when the agent runs with `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=html`.
 */
export type QuestionPreviewFormat = "html" | "markdown";

export interface QuestionOption {
  label: string;
  description?: string;
  /** A picture of what the option means: an HTML fragment or Markdown/ASCII. */
  preview?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
  /** Set when at least one option carries a preview. */
  previewFormat?: QuestionPreviewFormat;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseQuestionOption(input: unknown): QuestionOption | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.label !== "string") return null;
  const preview = readOptionalString(o, "preview");
  return {
    label: o.label,
    description: typeof o.description === "string" ? o.description : undefined,
    preview: preview?.trim() ? preview : undefined,
  };
}

// The tool input never says which format its previews are in: the agent process decides it from its
// environment. An HTML fragment opens with a tag; Markdown and ASCII art do not.
function readPreviewFormat(options: QuestionOption[]): QuestionPreviewFormat | undefined {
  const preview = options.find((option) => option.preview !== undefined)?.preview;
  if (preview === undefined) return undefined;
  return /^<[a-z][a-z0-9-]*(?=[\s/>])/i.test(preview.trimStart()) ? "html" : "markdown";
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("questions" in input) ||
    !Array.isArray((input as Record<string, unknown>).questions)
  ) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions as unknown[];
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || typeof q.header !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options as unknown[]) {
      const option = parseQuestionOption(opt);
      if (!option) return null;
      options.push(option);
    }
    questions.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      placeholder: readOptionalString(q, "placeholder"),
      dismissLabel: readOptionalString(q, "dismissLabel"),
      previewFormat: readPreviewFormat(options),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  qIndex: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[qIndex];
  if (selected && selected.size > 0) {
    return true;
  }

  if (!questionShowsTextInput(question)) {
    return false;
  }

  const otherText = otherTexts[qIndex]?.trim();
  if (otherText && otherText.length > 0) {
    return true;
  }

  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, qIndex) =>
      isQuestionAnswered(question, qIndex, selections, otherTexts),
    ) ?? false
  );
}

export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const selected = selections[i];
    const otherText = otherTexts[i]?.trim();
    const labels = selected ? Array.from(selected).map((idx) => q.options[idx].label) : [];

    if (questionShowsTextInput(q)) {
      if (otherText && otherText.length > 0) {
        // Multi-select keeps the checked options and appends the custom answer, the way
        // Claude Code's own AskUserQuestion UI does. Single-select replaces the option.
        answers[q.header] = q.multiSelect ? [...labels, otherText].join(", ") : otherText;
        continue;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = "";
        continue;
      }
    }

    if (labels.length > 0) {
      answers[q.header] = labels.join(", ");
    }
  }
  return answers;
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

export function resolveDismissLabel(
  questions: QuestionFormQuestion[],
  fallbackLabel = "Dismiss",
): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallbackLabel;
}

// No scripts, no network: a preview may only draw with inline styles and data: images.
const QUESTION_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * The document a sandboxed frame shows for an HTML preview. Previews are written for a light
 * page (Claude's own examples set no background), so the page is white in every theme.
 */
export function buildQuestionPreviewDocument(fragment: string): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${QUESTION_PREVIEW_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>html,body{margin:0;background:#fff;color:#111;",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    // The body takes the picture's own width (fit-content) and holds its children's margins
    // (flow-root), so the card can size the frame to exactly the picture.
    "body{width:fit-content;display:flow-root;overflow-wrap:anywhere}</style>",
    `</head><body>${fragment}</body></html>`,
  ].join("");
}
