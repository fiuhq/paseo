/**
 * One `fiu jev check` per candidate, on the title and its origin alone.
 *
 * Measured on 2026-11-06 (jev-1.14.0) on 22 titles, 0.4s each. With guesses from a prompt holding a
 * link refused before this runs, 10 of 11 good titles scored 0.75 or more and 5 of 6 generic ones 0.11 or
 * less. The sixth, "Summarize recent Slack messages", really was that prompt's task, and the
 * one miss waits for the agent's reply. Prompts and replies are not needed to get there.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { TitleJudge } from "../shared/title-gate.core";

const run = promisify(execFile);

const QUESTION =
  "Could someone scanning a list of work sessions tell this one apart from others by this title, " +
  "because it names the actual subject of the work?";
const YES = "it names a concrete subject of the work";
const NO =
  "it could fit almost any session, like 'Check link' or 'Review thread', or it only restates " +
  "that there was a link or pull request to look at";

/** Exported so the reading can be tested against real recorded output, not a mock. */
export function parseScore(stdout: string): number {
  const score = (JSON.parse(stdout) as { p_yes?: unknown }).p_yes;
  if (typeof score !== "number") throw new Error("the judge gave no score");
  return score;
}

export class JevTitleJudge extends TitleJudge {
  readonly name = "Jev";

  constructor(
    private readonly bin: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  protected async score(state: string): Promise<number> {
    // execFile, not a shell: the state is one argv entry, so no quoting can reshape it.
    const { stdout } = await run(
      this.bin,
      ["jev", "check", QUESTION, "--yes", YES, "--no", NO, "--text", state, "--json"],
      { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 },
    );
    return parseScore(stdout);
  }
}
