/**
 * The judge: one `fiu jev ask` per candidate turn, two yes/no questions in a single
 * round trip. Jev answers DECIDED — the answer plus the probability behind it — so the
 * reading is a pair of probabilities, never a distribution to interpret here.
 *
 * Measured on 2026-09-21 (jev-1.13.0), which is where the floor comes from:
 *   mid-task, announced a next step   done=no  0.98, hands-on=no  0.56 → 0.01
 *   finished discussion               done=yes 0.90, hands-on=no  0.10 → 0.50
 *   finished, code written and green  done=yes 0.94, hands-on=yes 0.91 → 0.90
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CompactJudge, type JudgeReading } from "../shared/compaction.core";

const run = promisify(execFile);

const DONE =
  "done: Is the assistant's latest answer a finished unit of work with nothing it said it would do next? " +
  ":: yes = complete, waiting for a new instruction | no = mid-task, or it announced a next step";

const HANDS_ON =
  "handson: Was this hands-on work that changed code, files or configuration, rather than discussion, planning or an answer? " +
  ":: yes = it edited, ran or built something | no = it explained, planned, searched or discussed";

interface JevAnswer {
  id?: unknown;
  answer?: unknown;
  p?: unknown;
}

interface JevResponse {
  model?: unknown;
  answers?: unknown;
}

/** P(yes) from a decided yes/no answer: the probability is behind the answer given. */
function yesProbability(answers: readonly JevAnswer[], id: string): number {
  const found = answers.find((answer) => answer.id === id);
  if (!found || typeof found.p !== "number" || (found.answer !== "yes" && found.answer !== "no")) {
    throw new Error(`the judge did not answer "${id}"`);
  }
  return found.answer === "yes" ? found.p : 1 - found.p;
}

/** Exported so the reading can be tested against real recorded output, not a mock. */
export function parseReading(stdout: string): JudgeReading {
  const parsed = JSON.parse(stdout) as JevResponse;
  const answers = Array.isArray(parsed.answers) ? (parsed.answers as JevAnswer[]) : [];
  return {
    finished: yesProbability(answers, "done"),
    handsOn: yesProbability(answers, "handson"),
    model: typeof parsed.model === "string" ? parsed.model : "unknown",
  };
}

export class JevJudge extends CompactJudge {
  constructor(
    private readonly bin: string,
    private readonly timeoutMs: number,
    private readonly cwd: string,
  ) {
    super();
  }

  async read(state: string): Promise<JudgeReading> {
    // execFile, not a shell: the state is one argv entry, so no quoting can reshape it.
    const { stdout } = await run(
      this.bin,
      ["jev", "ask", "--json", "--noul", DONE, "--noul", HANDS_ON, state],
      {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    return parseReading(stdout);
  }
}
