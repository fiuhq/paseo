import type { PluginServerContext } from "@getpaseo/plugin/server";
import { QuotesStore } from "./server/store";
import {
  addQuoteRpc,
  listQuotes,
  removeQuoteRpc,
  restoreQuoteRpc,
  setEnabledRpc,
} from "./shared/contracts";
import { addQuote, removeQuote, restoreQuote } from "./shared/quotes";

/**
 * daily-quotes: the host's list of quotes and whether New workspace shows them, in
 * `$PASEO_HOME/daily-quotes/quotes.json`. Clients compute today's quote from their own clock.
 */
export default function contribute(server: PluginServerContext) {
  const store = new QuotesStore();
  server.handle(listQuotes, () => store.read());
  server.handle(addQuoteRpc, ({ text, day }) =>
    store.update((current) => {
      const state = addQuote(current, text, day);
      return { state, result: state };
    }),
  );
  server.handle(removeQuoteRpc, ({ index, text, day }) =>
    store.update((current) => {
      const result = removeQuote(current, index, text, day);
      return { state: result.state, result };
    }),
  );
  server.handle(restoreQuoteRpc, ({ removed, day }) =>
    store.update((current) => {
      const state = restoreQuote(current, removed, day);
      return { state, result: state };
    }),
  );
  server.handle(setEnabledRpc, ({ enabled }) =>
    store.update((current) => {
      const state = { ...current, enabled };
      return { state, result: state };
    }),
  );
  return () => {};
}
