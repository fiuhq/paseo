import { expect, test } from "bun:test";
import { differences } from "./index.server";

test("a child matching its creator's model and effort has no differences", () => {
  expect(
    differences(
      { model: "claude-opus-5-5", thinkingOptionId: "xhigh" },
      { model: "claude-opus-5-5", thinkingOptionId: "xhigh" },
    ),
  ).toEqual([]);
});

test("names a different effort, a missing one, and a different model", () => {
  expect(
    differences(
      { model: "m", thinkingOptionId: "xhigh" },
      { model: "m", thinkingOptionId: "high" },
    ),
  ).toEqual(["thinkingOptionId high != xhigh"]);
  expect(differences({ model: "m", thinkingOptionId: "xhigh" }, { model: "m" })).toEqual([
    "thinkingOptionId (none) != xhigh",
  ]);
  expect(differences({ model: "a" }, { model: "b" })).toEqual(["model b != a"]);
});

test("an unreadable side is not a mismatch", () => {
  expect(differences(null, { model: "b" })).toEqual([]);
});
