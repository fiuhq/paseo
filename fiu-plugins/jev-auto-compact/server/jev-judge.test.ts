import { describe, expect, test } from "bun:test";

import { parseReading } from "./jev-judge";
import { score } from "../shared/compaction.core";

/** Recorded from `fiu jev ask --json` on 2026-09-21 — the shape the judge really returns. */
const RECORDED = JSON.stringify({
  model: "jev-1.13.0",
  weakest: { id: "done", type: "noul", answer: "yes", p: 0.94, confidence: "n/a", band: "medium" },
  asked: 2,
  answered: 2,
  answers: [
    { id: "done", type: "noul", answer: "yes", p: 0.94, confidence: "n/a", band: "medium" },
    { id: "handson", type: "noul", answer: "yes", p: 0.91, confidence: "n/a", band: "medium" },
  ],
  distributions: { done: { yes: 0.94, no: 0.06 }, handson: { yes: 0.91, no: 0.09 } },
  usage: { inputTokens: 511, outputTokens: 37 },
});

describe("parseReading", () => {
  test("reads both probabilities and the model that answered", () => {
    const reading = parseReading(RECORDED);
    expect(reading).toEqual({ finished: 0.94, handsOn: 0.91, model: "jev-1.13.0" });
    expect(score(reading)).toBeCloseTo(0.898, 3);
  });

  test("turns a decided 'no' into the probability of yes", () => {
    const midTask = JSON.stringify({
      model: "jev-1.13.0",
      answers: [
        { id: "done", type: "noul", answer: "no", p: 0.98 },
        { id: "handson", type: "noul", answer: "no", p: 0.56 },
      ],
    });
    const reading = parseReading(midTask);
    expect(reading.finished).toBeCloseTo(0.02, 6);
    expect(reading.handsOn).toBeCloseTo(0.44, 6);
    expect(score(reading)).toBeLessThan(0.02);
  });

  test("refuses a response that skipped a question instead of scoring it anyway", () => {
    const partial = JSON.stringify({
      model: "jev-1.13.0",
      answers: [{ id: "done", answer: "yes", p: 0.9 }],
    });
    expect(() => parseReading(partial)).toThrow('the judge did not answer "handson"');
  });

  test("refuses an answer with no probability behind it", () => {
    const vague = JSON.stringify({
      model: "jev-1.13.0",
      answers: [
        { id: "done", answer: "yes" },
        { id: "handson", answer: "yes", p: 0.9 },
      ],
    });
    expect(() => parseReading(vague)).toThrow('the judge did not answer "done"');
  });
});
