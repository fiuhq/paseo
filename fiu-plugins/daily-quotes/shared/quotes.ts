import { z } from "zod";

/**
 * The rotation, pure. The daemon keeps one list per host and each client computes today from its
 * own clock, so every client on the same calendar day shows the same quote.
 *
 * Today's quote is `quotes[(day - anchorDay) mod n]`, where `day` is the local calendar day number.
 * Every change re-anchors on the day it was made, so adding or removing one quote never moves the
 * others: today's stays today's, and removing today's hands today to the next one.
 */

export const MAX_QUOTE_LENGTH = 140;

/** The operator's own list, in rotation order; the first is today's on the day the store is born. */
export const SEED_QUOTES = [
  "Be more ambitious",
  "Pitch hard, get roasted hard",
  "Soc2 compliance for vietnam",
] as const;

export const QuotesStateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  quotes: z.array(z.string()),
  /** The day on which `quotes[0]` is today's quote. */
  anchorDay: z.number().int(),
});

export type QuotesState = z.infer<typeof QuotesStateSchema>;

/** A removed quote, kept by the screen that removed it so Undo can put it back. */
export interface RemovedQuote {
  index: number;
  text: string;
  wasToday: boolean;
}

export interface RotationRow {
  /** Where the quote sits in the stored list. */
  index: number;
  text: string;
  /** 0 for today, 1 for tomorrow, and so on. */
  daysFromToday: number;
}

const DAY_MS = 86_400_000;

/** The local calendar day number of `date`: days since 1970-01-01 on the device's calendar. */
export function dayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** "Today", then the date: "Thu 12 Nov". */
export function dayLabel(day: number, daysFromToday: number): string {
  if (daysFromToday === 0) return "Today";
  return new Date((day + daysFromToday) * DAY_MS).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

export function seedState(day: number): QuotesState {
  return { version: 1, enabled: true, quotes: [...SEED_QUOTES], anchorDay: day };
}

/** Where today's quote sits in the list, or `null` when there are none. */
export function todayIndex(state: QuotesState, day: number): number | null {
  return state.quotes.length ? mod(day - state.anchorDay, state.quotes.length) : null;
}

export function todayQuote(state: QuotesState, day: number): string | null {
  const index = todayIndex(state, day);
  return index === null ? null : state.quotes[index];
}

/** The quotes in the order they come up, starting with today's. */
export function rotation(state: QuotesState, day: number): RotationRow[] {
  const today = todayIndex(state, day);
  if (today === null) return [];
  return state.quotes.map((_, daysFromToday) => {
    const index = mod(today + daysFromToday, state.quotes.length);
    return { index, text: state.quotes[index], daysFromToday };
  });
}

/** `quotes`, anchored so `today` is today's index on `day`. */
function anchored(state: QuotesState, quotes: string[], today: number, day: number): QuotesState {
  return { ...state, quotes, anchorDay: day - today };
}

export function cleanQuote(text: string): string {
  const quote = text.trim();
  if (!quote) throw new Error("Write a quote first");
  if (quote.length > MAX_QUOTE_LENGTH)
    throw new Error(`Keep a quote to ${MAX_QUOTE_LENGTH} characters`);
  return quote;
}

/** Adds `text` at the end of the rotation: the day before today's quote comes round again. */
export function addQuote(state: QuotesState, text: string, day: number): QuotesState {
  const quote = cleanQuote(text);
  const today = todayIndex(state, day);
  if (today === null) return anchored(state, [quote], 0, day);
  const quotes = [...state.quotes];
  quotes.splice(today, 0, quote);
  return anchored(state, quotes, today + 1, day);
}

/**
 * Removes the quote at `index`. `text` must still be there, so a screen showing an older list
 * cannot remove a different quote.
 */
export function removeQuote(
  state: QuotesState,
  index: number,
  text: string,
  day: number,
): { state: QuotesState; removed: RemovedQuote } {
  if (state.quotes[index] !== text) throw new Error("That quote is no longer in the list");
  const today = todayIndex(state, day) ?? 0;
  const quotes = state.quotes.filter((_, at) => at !== index);
  const removed = { index, text, wasToday: index === today };
  if (!quotes.length) return { state: anchored(state, quotes, 0, day), removed };
  // Removing today's quote leaves the next one at the same index (or the first, past the end).
  const next = index < today ? today - 1 : index === today ? mod(index, quotes.length) : today;
  return { state: anchored(state, quotes, next, day), removed };
}

/** Puts a removed quote back where it was; today's quote goes back to being today's. */
export function restoreQuote(state: QuotesState, removed: RemovedQuote, day: number): QuotesState {
  const quote = cleanQuote(removed.text);
  const at = Math.min(Math.max(removed.index, 0), state.quotes.length);
  const today = todayIndex(state, day);
  const quotes = [...state.quotes];
  quotes.splice(at, 0, quote);
  const next = removed.wasToday || today === null ? at : today >= at ? today + 1 : today;
  return anchored(state, quotes, next, day);
}
