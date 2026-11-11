import { describe, expect, test } from "bun:test";
import { RequestBudget, retryAfterMs } from "./budget";

/** A clock that only moves when the budget waits, so every wait is measured exactly. */
function clock(start = 0) {
  const waits: number[] = [];
  let now = start;
  return {
    waits,
    now: () => now,
    wait: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

describe("a token's request budget", () => {
  test("lets requests through at once while a minute holds fewer than its limit", async () => {
    const c = clock();
    const budget = new RequestBudget(3, c.now, c.wait);
    await Promise.all([budget.take(), budget.take(), budget.take()]);
    expect(c.waits).toEqual([]);
  });

  test("holds the request past the limit until the oldest one is a minute old", async () => {
    const c = clock(10_000);
    const budget = new RequestBudget(2, c.now, c.wait);
    await Promise.all([budget.take(), budget.take(), budget.take()]);
    expect(c.waits).toEqual([60_000]);
    expect(c.now()).toBe(70_000);
  });

  test("never lets any 60 s hold more than its limit, however many callers ask at once", async () => {
    const c = clock();
    const budget = new RequestBudget(5, c.now, c.wait);
    const at: number[] = [];
    await Promise.all(Array.from({ length: 23 }, () => budget.take().then(() => at.push(c.now()))));
    for (const start of at)
      expect(at.filter((t) => t >= start && t < start + 60_000).length).toBeLessThanOrEqual(5);
    expect(at).toHaveLength(23);
  });

  test("after a refusal, nobody asks again until Workfloor's next minute has begun", async () => {
    const c = clock(125_000);
    const budget = new RequestBudget(100, c.now, c.wait);
    budget.refused();
    await budget.take();
    expect(c.now()).toBe(182_000);
  });

  test("a Retry-After Workfloor sends is the pause", async () => {
    const c = clock(125_000);
    const budget = new RequestBudget(100, c.now, c.wait);
    budget.refused(7_000);
    await budget.take();
    expect(c.now()).toBe(132_000);
  });
});

describe("Retry-After", () => {
  test("reads seconds and an HTTP date, and nothing else", () => {
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs("Wed, 11 Nov 2026 08:00:30 GMT", Date.parse("2026-11-11T08:00:00Z"))).toBe(
      30_000,
    );
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});
