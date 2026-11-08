import { describe, expect, it } from "bun:test";

import { parseScore } from "./jev-title-judge";

describe("parseScore", () => {
  it("reads a recorded `fiu jev check --json`", () => {
    const recorded =
      '{"verdict":"no","p_yes":0.42,"confidence":0.16,"band":"escalate","usage":"381in/20out 476ms jev-1.14.0 $0.00002"}';
    expect(parseScore(recorded)).toBe(0.42);
  });

  it("a reply with no score is an error, never a zero", () => {
    expect(() => parseScore('{"verdict":"no"}')).toThrow("no score");
  });
});
