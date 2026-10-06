/** How an option's `preview` is written. Claude's AskUserQuestion defaults to Markdown. */
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

function readPreviewFormat(
  question: Record<string, unknown>,
  options: QuestionOption[],
): QuestionPreviewFormat | undefined {
  if (!options.some((option) => option.preview !== undefined)) return undefined;
  return question.previewFormat === "html" ? "html" : "markdown";
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
      previewFormat: readPreviewFormat(q, options),
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

/**
 * The option whose preview the card shows: the latest pick that has one, or the first option
 * with one before anything is picked. A pick without a preview shows none.
 */
export function previewedOptionIndex(
  question: QuestionFormQuestion,
  selected: ReadonlySet<number>,
): number | null {
  if (!question.previewFormat) return null;
  if (selected.size > 0) {
    const picked = Array.from(selected).findLast(
      (index) => question.options[index]?.preview !== undefined,
    );
    return picked ?? null;
  }
  const first = question.options.findIndex((option) => option.preview !== undefined);
  return first === -1 ? null : first;
}

/**
 * A single-select pick moves on to the next question, unless the options carry previews:
 * picking is how they are compared, so the question stays until Next.
 */
export function questionAdvancesOnPick(question: QuestionFormQuestion): boolean {
  return !question.multiSelect && !question.previewFormat;
}

// No scripts, no network: a preview may only draw with inline styles and data: images.
const QUESTION_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * The document a sandboxed frame shows for an HTML preview. Previews are written for a light
 * page (Claude's own examples assume one), so the sheet is white in every theme.
 */
export function buildQuestionPreviewDocument(fragment: string): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${QUESTION_PREVIEW_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>html,body{margin:0;background:#fff;color:#111;",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    "body{padding:12px;overflow-wrap:anywhere}</style>",
    `</head><body>${fragment}</body></html>`,
  ].join("");
}
