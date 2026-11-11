import { describe, expect, test } from "bun:test";
import {
  addQuote,
  dayLabel,
  dayNumber,
  removeQuote,
  restoreQuote,
  rotation,
  seedState,
  todayQuote,
  type QuotesState,
} from "./quotes";

const DAY = dayNumber(new Date(2026, 10, 11));
const texts = (state: QuotesState, day = DAY) => rotation(state, day).map((row) => row.text);

describe("dayNumber", () => {
  test("counts local calendar days, whatever the hour", () => {
    expect(dayNumber(new Date(2026, 10, 11, 0, 0))).toBe(dayNumber(new Date(2026, 10, 11, 23, 59)));
    expect(dayNumber(new Date(2026, 10, 12))).toBe(dayNumber(new Date(2026, 10, 11)) + 1);
    expect(dayNumber(new Date(2027, 0, 1))).toBe(dayNumber(new Date(2026, 11, 31)) + 1);
  });
});

describe("dayLabel", () => {
  test("names today, then each following date", () => {
    expect([0, 1, 2].map((offset) => dayLabel(DAY, offset))).toEqual([
      "Today",
      "Thu 12 Nov",
      "Fri 13 Nov",
    ]);
  });
});

describe("rotation", () => {
  test("starts from today's quote and moves one a day", () => {
    const state = seedState(DAY);
    expect(texts(state)).toEqual([
      "Be more ambitious",
      "Pitch hard, get roasted hard",
      "Soc2 compliance for vietnam",
    ]);
    expect(rotation(state, DAY).map((row) => row.daysFromToday)).toEqual([0, 1, 2]);
    expect(todayQuote(state, DAY + 1)).toBe("Pitch hard, get roasted hard");
    expect(todayQuote(state, DAY + 3)).toBe("Be more ambitious");
    expect(todayQuote(state, DAY - 1)).toBe("Soc2 compliance for vietnam");
  });

  test("is empty with no quotes", () => {
    const state = { ...seedState(DAY), quotes: [] };
    expect(rotation(state, DAY)).toEqual([]);
    expect(todayQuote(state, DAY)).toBeNull();
  });
});

describe("addQuote", () => {
  test("adds to the end of the rotation and keeps today's quote", () => {
    const later = DAY + 1;
    const state = addQuote(seedState(DAY), "  Ship it  ", later);
    expect(texts(state, later)).toEqual([
      "Pitch hard, get roasted hard",
      "Soc2 compliance for vietnam",
      "Be more ambitious",
      "Ship it",
    ]);
  });

  test("makes the first quote today's", () => {
    const state = addQuote({ ...seedState(DAY), quotes: [] }, "Ship it", DAY);
    expect(todayQuote(state, DAY)).toBe("Ship it");
  });

  test("refuses an empty or overlong quote", () => {
    expect(() => addQuote(seedState(DAY), "   ", DAY)).toThrow("Write a quote first");
    expect(() => addQuote(seedState(DAY), "x".repeat(141), DAY)).toThrow("140 characters");
  });
});

describe("removeQuote and restoreQuote", () => {
  test("removing today's quote hands today to the next, and Undo restores it", () => {
    const seeded = seedState(DAY);
    const { state, removed } = removeQuote(seeded, 0, "Be more ambitious", DAY);
    expect(removed).toEqual({ index: 0, text: "Be more ambitious", wasToday: true });
    expect(texts(state)).toEqual(["Pitch hard, get roasted hard", "Soc2 compliance for vietnam"]);
    expect(texts(restoreQuote(state, removed, DAY))).toEqual(texts(seeded));
  });

  test("removing the last quote in the list while it is today's hands today to the first", () => {
    const day = DAY + 2;
    const { state } = removeQuote(seedState(DAY), 2, "Soc2 compliance for vietnam", day);
    expect(todayQuote(state, day)).toBe("Be more ambitious");
  });

  test("removing another quote keeps today's, and Undo puts it back in its place", () => {
    const later = DAY + 1;
    const seeded = seedState(DAY);
    const { state, removed } = removeQuote(seeded, 0, "Be more ambitious", later);
    expect(removed.wasToday).toBe(false);
    expect(texts(state, later)).toEqual([
      "Pitch hard, get roasted hard",
      "Soc2 compliance for vietnam",
    ]);
    expect(texts(restoreQuote(state, removed, later), later)).toEqual(texts(seeded, later));
  });

  test("removing every quote leaves an empty list that a restore refills", () => {
    const { state, removed } = removeQuote({ ...seedState(DAY), quotes: ["Only"] }, 0, "Only", DAY);
    expect(state.quotes).toEqual([]);
    expect(todayQuote(restoreQuote(state, removed, DAY), DAY)).toBe("Only");
  });

  test("refuses to remove a quote that has moved", () => {
    expect(() => removeQuote(seedState(DAY), 1, "Be more ambitious", DAY)).toThrow(
      "no longer in the list",
    );
  });
});
