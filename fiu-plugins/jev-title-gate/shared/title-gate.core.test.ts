import { describe, expect, it } from "bun:test";

import { buildState, hasLink, PASS_BAR, redact, TitleJudge } from "./title-gate.core";

class FixedJudge extends TitleJudge {
  readonly name = "Fixed";
  states: string[] = [];

  constructor(private readonly result: number | Error) {
    super();
  }

  protected async score(state: string): Promise<number> {
    this.states.push(state);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("TitleJudge", () => {
  it("accepts at the bar and refuses under it", async () => {
    expect(await new FixedJudge(PASS_BAR).verdict("t", "prompt", "fix it")).toEqual({
      decision: "accept",
      score: PASS_BAR,
      judge: "Fixed",
    });
    expect(await new FixedJudge(0.69).verdict("t", "prompt", "fix it")).toEqual({
      decision: "refuse",
      score: 0.69,
      judge: "Fixed",
    });
  });

  it("a judge that fails gives unchecked, so naming never stops", async () => {
    expect(await new FixedJudge(new Error("401")).verdict("t", "prompt", "fix it")).toEqual({
      decision: "unchecked",
      score: null,
      judge: "Fixed",
    });
  });

  it("refuses a guess from a bare link without asking anyone", async () => {
    const judge = new FixedJudge(0.99);

    expect(await judge.verdict("Triage issue", "prompt", "https://x.dev/a/b")).toEqual({
      decision: "refuse",
      score: 0,
      judge: "Fixed",
    });
    expect(judge.states).toEqual([]);
  });

  it("a reply-based title still goes to the judge when the prompt was only a link", async () => {
    const judge = new FixedJudge(0.9);

    await judge.verdict("Fix login", "reply", "https://x.dev/a/b");

    expect(judge.states).toHaveLength(1);
  });
});

describe("hasLink", () => {
  it.each([
    "https://acme.slack.com/archives/C0AB/p1793",
    "(https://x.dev/a)",
    "_https://localhost/a_",
    "1https://x.dev/a",
    "github.com/flxbl-io/sfp-pro/pull/123",
    "dev6.flxbl.io/projects/acme-corp/settings",
    "https://acme.slack.com/archives/C/p1 can you take a look at this please",
  ])("%s", (text) => {
    expect(hasLink(text)).toBe(true);
  });

  it.each([
    "",
    "fix it",
    "version 1.2.3 is broken",
    "Update CLAUDE.md/AGENTS.md rules",
    "Migrate from node.js/express to bun",
    "Fix tsconfig.json/package.json drift",
  ])("%s is not", (text) => {
    expect(hasLink(text)).toBe(false);
  });
});

describe("what leaves the machine", () => {
  it("is only the title and its origin, never the source", async () => {
    const judge = new FixedJudge(0.9);

    await judge.verdict("Fix login on acme.example.com", "reply", "password=hunter2 for Acme Corp");

    expect(judge.states).toEqual([
      "Written from: the agent's reply after it read the work.\nCandidate title: Fix login on acme.example.com",
    ]);
  });

  it("a title keeps the paths and ids that make it specific, but no link or mail address", () => {
    expect(redact("Fix /api/orders 500 error")).toBe("Fix /api/orders 500 error");
    expect(redact("Merge foo.ts/bar.ts")).toBe("Merge foo.ts/bar.ts");
    expect(redact("See https://x.dev/a from me@acme.io")).toBe("See <url> from <email>");
    expect(redact("Reply to jane.doe+billing@acme.io today")).toBe("Reply to <email> today");
    expect(redact("Reply to conor.o'brien@acme.io today")).toBe("Reply to <email> today");
    expect(redact("Reply to trần@acme.vn today")).toBe("Reply to <email> today");
    expect(redact("Reply to me@công-ty.vn today")).toBe("Reply to <email> today");
    expect(redact("See _https://x.dev/secret-path_ now")).toBe("See _<url> now");
    expect(redact("Check 1https://x.dev/a")).toBe("Check 1<url>");
    expect(redact("Reply to me@công-ty.vn today".normalize("NFD"))).toBe("Reply to <email> today");
    expect(redact("Reply to me@ภูเก็ต.ไทย today")).toBe("Reply to <email> today");
    expect(redact("Upgrade lodash@4.17.21 and foo@bar")).toBe("Upgrade lodash@4.17.21 and foo@bar");
  });

  it("names where a title came from", () => {
    expect(buildState("t", "prompt")).toContain("the user's own description");
  });
});
