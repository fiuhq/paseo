import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_QUOTE_LENGTH, QuotesStateSchema } from "./quotes";

/** The calling client's local calendar day (`dayNumber`), so a change re-anchors on its today. */
const Day = z.number().int();
const Quote = z.string().max(MAX_QUOTE_LENGTH);

export const listQuotes = defineRpc({
  name: "daily-quotes.list",
  input: z.object({}),
  output: QuotesStateSchema,
});

export const addQuoteRpc = defineRpc({
  name: "daily-quotes.add",
  input: z.object({ text: Quote, day: Day }),
  output: QuotesStateSchema,
});

export const removeQuoteRpc = defineRpc({
  name: "daily-quotes.remove",
  input: z.object({ index: z.number().int().min(0), text: z.string(), day: Day }),
  output: z.object({
    state: QuotesStateSchema,
    removed: z.object({ index: z.number().int(), text: z.string(), wasToday: z.boolean() }),
  }),
});

export const restoreQuoteRpc = defineRpc({
  name: "daily-quotes.restore",
  input: z.object({
    removed: z.object({ index: z.number().int().min(0), text: Quote, wasToday: z.boolean() }),
    day: Day,
  }),
  output: QuotesStateSchema,
});

export const setEnabledRpc = defineRpc({
  name: "daily-quotes.set-enabled",
  input: z.object({ enabled: z.boolean() }),
  output: QuotesStateSchema,
});
