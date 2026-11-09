import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Workfloor's address from this host's settings, for links the client builds. */
export const readAddress = defineRpc({
  name: "workfloor-provider.address.read",
  input: z.object({}),
  output: z.object({ url: z.string() }),
});

export interface CardAgent {
  provider: string;
  persistence?: { metadata?: Record<string, unknown> } | null;
}

/** The Workfloor card an agent of this provider is on; undefined until it has one. */
export function cardOf(agent: CardAgent): string | undefined {
  if (agent.provider !== "workfloor") return undefined;
  const saved = agent.persistence?.metadata?.pluginProviderPersistence as
    | { data?: { card?: unknown } }
    | undefined;
  const card = saved?.data?.card;
  return typeof card === "string" && card ? card : undefined;
}

/** Workfloor's short link opens the card on whichever lane it is on now. */
export const cardUrl = (url: string, card: string) => `${url.replace(/\/+$/, "")}/c/${card}`;

/** The card's reference as Workfloor shows it: the last eight characters of its id. */
export const reference = (card: string) => card.slice(-8);
