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

// Nothing the page asks for is fetched: a preview draws with inline styles and data: images, and
// its inline scripts run in the frame's own opaque origin (the frame never gets
// `allow-same-origin`), so they cannot reach the app, its storage or the daemon. A policy cannot
// stop a page navigating itself away; the frame's script cancels link clicks and the card undoes
// a navigation (see the web preview frame), but the navigation's own request can still leave.
const QUESTION_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Marks every message between the card and a preview frame, both ways. */
export const QUESTION_PREVIEW_MESSAGE_MARKER = "paseoQuestionPreview";

/** A picture taller than this is fitted to it, as a wide one is to its option's width. */
export const QUESTION_PREVIEW_MAX_HEIGHT = 360;

// Runs first in every preview frame. It reports the picture's drawn size with the width of the
// frame it was laid out in (a picture of text wraps to its frame), again whenever the page changes
// (a click can open a positioned panel without resizing the body), and while the card has
// the picture zoomed in it hands the card the wheel and touch drags the frame would otherwise
// swallow, so they pan the picture. At the fitted size the wheel is left alone and scrolls the
// conversation. Clicks on links are cancelled, so the picture stays where it is. A plain string,
// so nothing a bundler adds to functions ends up in the frame.
const QUESTION_PREVIEW_BOOTSTRAP = `(() => {
  const marker = "${QUESTION_PREVIEW_MESSAGE_MARKER}";
  const post = (message) => window.parent.postMessage({ [marker]: true, ...message }, "*");
  const extent = (body, origin) => {
    let left = 0;
    let top = 0;
    let right = Math.max(origin.width, body.scrollWidth);
    let bottom = Math.max(origin.height, body.scrollHeight);
    for (const element of body.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height && !element.scrollWidth && !element.scrollHeight) continue;
      left = Math.min(left, rect.left - origin.left);
      top = Math.min(top, rect.top - origin.top);
      right = Math.max(right, rect.right - origin.left, rect.left - origin.left + element.scrollWidth);
      bottom = Math.max(bottom, rect.bottom - origin.top, rect.top - origin.top + element.scrollHeight);
    }
    return { left, top, right, bottom };
  };
  let reported = "";
  const measure = () => {
    const body = document.body;
    if (!body) return;
    body.style.margin = "0";
    const box = extent(body, body.getBoundingClientRect());
    if (box.left < 0 || box.top < 0)
      body.style.margin = -Math.min(box.top, 0) + "px 0 0 " + -Math.min(box.left, 0) + "px";
    const width = Math.ceil(box.right - box.left);
    const height = Math.ceil(box.bottom - box.top);
    const viewport = window.innerWidth;
    const key = width + "x" + height + "@" + viewport;
    if (!width || !height || key === reported) return;
    reported = key;
    post({ type: "size", width, height, viewport });
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      measure();
    }, 0);
  };
  // The page's own changes, not the style this script writes on the page and its body.
  const changed = (records) =>
    records.some((record) => record.attributeName !== "style" || (record.target !== document.body && record.target !== document.documentElement));
  let zoomed = false;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data || data[marker] !== true || data.type !== "state") return;
    zoomed = data.zoomed === true;
    document.documentElement.style.touchAction = zoomed ? "none" : "";
  });
  window.addEventListener("wheel", (event) => {
    const zoom = event.ctrlKey || event.metaKey;
    if (!zoomed && !zoom) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    post({ type: "wheel", deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, zoom, x: event.clientX, y: event.clientY });
  }, { passive: false });
  let drag = null;
  let dragged = false;
  window.addEventListener("pointerdown", (event) => {
    if (!zoomed || event.pointerType === "mouse" || !event.isPrimary) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.screenX - drag.x;
    const dy = event.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.x = event.screenX;
    drag.y = event.screenY;
    post({ type: "pan", dx, dy });
  }, true);
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    dragged = drag.moved;
    drag = null;
  };
  window.addEventListener("pointerup", endDrag, true);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("click", (event) => {
    if (!dragged) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
    if (link && !(link.getAttribute("href") || "").startsWith("#")) event.preventDefault();
  }, true);
  window.addEventListener("load", () => {
    measure();
    new ResizeObserver(measure).observe(document.body);
    new MutationObserver((records) => {
      if (changed(records)) schedule();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener("resize", measure);
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
  });
})();`;

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
    `<script>${QUESTION_PREVIEW_BOOTSTRAP}</script>`,
    "<style>html,body{margin:0;background:#fff;color:#111;",
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    // The body takes the picture's own width (fit-content) and holds its children's margins
    // (flow-root), so the card can size the frame to exactly the picture. It is also the
    // containing block for absolutely positioned content (relative), so its scroll size counts it.
    "body{position:relative;width:fit-content;display:flow-root;overflow-wrap:anywhere}</style>",
    `</head><body>${fragment}</body></html>`,
  ].join("");
}

export interface QuestionPreviewSize {
  width: number;
  height: number;
}

/**
 * What a preview frame tells the card. Positions are in the frame's own pixels; `viewport` is the
 * width of the frame the picture was laid out in when it was measured.
 */
export type QuestionPreviewFrameMessage =
  | { type: "size"; width: number; height: number; viewport: number }
  | { type: "wheel"; deltaX: number; deltaY: number; zoom: boolean; x: number; y: number }
  | { type: "pan"; dx: number; dy: number };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A preview frame's message, or null for anything else the page receives. */
export function readQuestionPreviewFrameMessage(data: unknown): QuestionPreviewFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message[QUESTION_PREVIEW_MESSAGE_MARKER] !== true) return null;
  if (message.type === "size") {
    const { width, height, viewport } = message;
    return isFiniteNumber(width) &&
      isFiniteNumber(height) &&
      isFiniteNumber(viewport) &&
      width > 0 &&
      height > 0
      ? { type: "size", width, height, viewport }
      : null;
  }
  if (message.type === "wheel") {
    const { deltaX, deltaY, x, y } = message;
    return isFiniteNumber(deltaX) &&
      isFiniteNumber(deltaY) &&
      isFiniteNumber(x) &&
      isFiniteNumber(y)
      ? { type: "wheel", deltaX, deltaY, zoom: message.zoom === true, x, y }
      : null;
  }
  if (message.type === "pan") {
    const { dx, dy } = message;
    return isFiniteNumber(dx) && isFiniteNumber(dy) ? { type: "pan", dx, dy } : null;
  }
  return null;
}

/** Tells a preview frame whether the card has its picture zoomed in past the fitted size. */
export function questionPreviewStateMessage(zoomed: boolean) {
  return { [QUESTION_PREVIEW_MESSAGE_MARKER]: true, type: "state", zoomed };
}

/** The box a picture is fitted into: its own size, scaled down to the option's width and the height limit. */
export function questionPreviewBox(
  picture: QuestionPreviewSize,
  room: number,
): QuestionPreviewSize {
  const scale = Math.min(1, room / picture.width, QUESTION_PREVIEW_MAX_HEIGHT / picture.height);
  return {
    width: Math.max(1, Math.round(picture.width * scale)),
    height: Math.max(1, Math.round(picture.height * scale)),
  };
}
