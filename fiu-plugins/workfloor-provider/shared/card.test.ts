import { expect, test } from "bun:test";
import { cardOf, cardUrl, reference } from "./card";

const card = "01a1bfa4-5793-7000-a19d-030fd9c8d3b6";
const saved = (data: unknown) => ({
  sessionId: "plugin:…",
  metadata: { pluginProviderPersistence: { version: 1, data } },
});

test("a Workfloor agent's card comes from its saved session", () => {
  expect(
    cardOf({ provider: "workfloor", persistence: saved({ project: "p", card, lane: "l" }) }),
  ).toBe(card);
});

test("no card before the first send, and none for another provider", () => {
  expect(cardOf({ provider: "workfloor", persistence: null })).toBeUndefined();
  expect(cardOf({ provider: "workfloor", persistence: saved({ project: "p" }) })).toBeUndefined();
  expect(
    cardOf({ provider: "claude", persistence: saved({ project: "p", card }) }),
  ).toBeUndefined();
});

test("the link and reference match Workfloor's own", () => {
  expect(cardUrl("https://flxbl.workfloor.cloud/", card)).toBe(
    `https://flxbl.workfloor.cloud/c/${card}`,
  );
  expect(reference(card)).toBe("d9c8d3b6");
});
