/** The hook's request, kept here so a bare Git install resolves no Paseo package. */
export interface TitleRequest {
  workspaceId: string;
  candidate: { title: string; branch: string | null };
  source: "prompt" | "reply";
  sourceText: string;
  attempt: number;
  verdict: TitleVerdict | null;
}

export interface TitleVerdict {
  decision: "accept" | "refuse" | "unchecked";
  score: number | null;
  judge: string | null;
}

/** Jev's `p` is calibrated, and the workspace's bar for acting on it is 0.70. */
export const PASS_BAR = 0.7;

/** With or without a scheme: `github.com/org/repo/pull/1` is a link, `CLAUDE.md/AGENTS.md` is not. */
const ANY_LINK =
  /[a-z][a-z0-9+.-]*:\/\/|\b(?:[a-z0-9-]+\.)+(?!(?:md|json|tsx?|jsx?|ya?ml|txt|toml|lock)\/)[a-z]{2,}\//i;

/**
 * A guess from a prompt with a link has not read what the link points to, however well the
 * words around it sound. The cost of refusing a good one is waiting for the agent's reply.
 */
export function hasLink(text: string): boolean {
  return ANY_LINK.test(text);
}

/**
 * Only what cannot be part of a good title goes. Paths, ids, file names and names stay: they
 * are often the very thing that tells this session from another.
 */
export function redact(title: string): string {
  return title
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\S+@[\p{L}\p{M}\p{N}.-]+\.\p{L}[\p{L}\p{M}]+/gu, "<email>");
}

const ORIGIN: Record<TitleRequest["source"], string> = {
  prompt: "the user's own description of the task.",
  reply: "the agent's reply after it read the work.",
};

/**
 * All that leaves the machine: the title and where it came from. Never the prompt or the
 * reply: redaction cannot catch a customer's name in prose, and the judge does not need them.
 */
export function buildState(title: string, origin: TitleRequest["source"]): string {
  return `Written from: ${ORIGIN[origin]}\nCandidate title: ${redact(title)}`;
}

/** One judge, one bar: an implementor only says how it scores. */
export abstract class TitleJudge {
  abstract readonly name: string;

  /** The probability that the title names the actual subject of the work. */
  protected abstract score(state: string): Promise<number>;

  async verdict(
    title: string,
    origin: TitleRequest["source"],
    sourceText: string,
  ): Promise<TitleVerdict> {
    if (origin === "prompt" && hasLink(sourceText)) {
      return { decision: "refuse", score: 0, judge: this.name };
    }
    try {
      const score = await this.score(buildState(title, origin));
      return { decision: score >= PASS_BAR ? "accept" : "refuse", score, judge: this.name };
    } catch (error) {
      // Naming must not stop because the judge did: Paseo shows the title as not checked.
      console.error(`[jev-title-gate] ${this.name} unreachable: ${String(error)}`);
      return { decision: "unchecked", score: null, judge: this.name };
    }
  }
}
