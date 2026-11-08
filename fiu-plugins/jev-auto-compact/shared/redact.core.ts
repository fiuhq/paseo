/**
 * Best-effort redaction of everything that identifies a machine, a repository or a
 * tenant, applied before any conversation text leaves the daemon for the judge.
 *
 * The judge only has to decide whether a unit of work is FINISHED, which survives
 * losing every identifier; so this errs towards deleting too much. It is
 * best-effort, never a guarantee — a session holding material that must not leave
 * the machine belongs to `providers: []` or `enabled: false`, not to a better regex.
 */

const RULES: ReadonlyArray<{ pattern: RegExp; with: string }> = [
  // Ordered: the greedy locators (urls, git remotes) run before the token rules that
  // would otherwise eat half of them and leave an identifying tail behind.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+/gi, with: "<url>" },
  { pattern: /\b[a-z0-9._%-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, with: "<email>" },
  { pattern: /\b[a-z0-9._-]+@[a-z0-9.-]+:[^\s]+/gi, with: "<remote>" },
  { pattern: /(?:^|(?<=[\s"'`(<[=:]))~?\/[^\s"'`)>\]]+/g, with: "<path>" },
  {
    pattern: /\b(?:[a-z0-9-]+\.)+(?:com|io|dev|sh|ai|net|org|local|internal|app|cloud|me|one)\b/gi,
    with: "<host>",
  },
  { pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, with: "<host>" },
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, with: "<id>" },
  { pattern: /\b[0-9a-f]{12,}\b/gi, with: "<id>" },
  { pattern: /\b[A-Za-z0-9_-]{24,}\b/g, with: "<id>" },
];

/** Escapes a configured word so it can join the rules as a literal, case-insensitively. */
function wordRule(word: string): { pattern: RegExp; with: string } {
  return { pattern: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), with: "<name>" };
}

/**
 * @param words extra literals to remove — the project, tenant and org names a regex
 *   cannot recognise on its own (`settings.redactWords`).
 */
export function redact(text: string, words: readonly string[] = []): string {
  let out = text;
  for (const rule of [...words.filter((w) => w.trim().length > 1).map(wordRule), ...RULES]) {
    out = out.replace(rule.pattern, rule.with);
  }
  return out;
}

const ENCODER = new TextEncoder();

/** What a request body is actually measured in. `String.length` counts UTF-16 units, not bytes. */
export function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Clips to a UTF-8 BYTE budget.
 *
 * A character limit does not bound a request: one CJK character is three bytes, so a
 * 900-character answer is 2.7 kB on its own. Only a total in bytes bounds what leaves the
 * machine, so the per-field limits below are budgets and this is the ceiling over them.
 */
export function clipBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = " […]";
  const budget = maxBytes - byteLength(marker);
  if (budget <= 0) return marker.trim();
  // The largest prefix that fits. Measured with the same encoder, so a split surrogate pair —
  // which encodes as one replacement character — is counted as what would actually be sent.
  let fits = 0;
  let over = text.length;
  while (fits < over) {
    const mid = Math.ceil((fits + over) / 2);
    if (byteLength(text.slice(0, mid)) <= budget) fits = mid;
    else over = mid - 1;
  }
  return `${text.slice(0, fits)}${marker}`;
}

/** Redacts, collapses whitespace and clips to a UTF-8 byte budget. */
export function clipTo(text: string, maxBytes: number, words: readonly string[] = []): string {
  return clipBytes(redact(text, words).replace(/\s+/g, " ").trim(), maxBytes);
}
