import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DailyQuotesSettings } from "./client/settings";
import { QuoteTitle } from "./client/title";
import { today } from "./client/quotes";
import { addQuoteRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addNewWorkspaceTitle !== "function") {
    throw new Error(
      "Daily quotes needs a Paseo build with client.addNewWorkspaceTitle (New workspace titles)",
    );
  }
  const removers = [
    client.addNewWorkspaceTitle({ id: "quote", Component: QuoteTitle }),
    client.addSettingsScreen({
      id: "quotes",
      title: "Daily quotes",
      icon: "Quote",
      Component: DailyQuotesSettings,
    }),
    client.addSlashCommand({
      name: "quote",
      description: "Add a daily quote",
      argumentHint: "<text>",
      context: "workspace",
      async onSubmit({ args, rpc }) {
        await rpc(addQuoteRpc, { text: args, day: today() });
      },
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
