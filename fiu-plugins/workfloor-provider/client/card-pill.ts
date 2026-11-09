/** A pill above the chat box of every Workfloor agent that is on a card: its reference, opening the card. */
import {
  openExternalUrl,
  type PluginButton,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { cardOf, cardUrl, readAddress, reference, type CardAgent } from "../shared/card";

type Agent = CardAgent & { id: string; workspaceId?: string | null; archivedAt?: string | null };

export function contributeCardPills(client: PluginClientContext): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; card: string }>();
  const lifetime = new AbortController();

  const button = (card: string): PluginButton => ({
    title: `Open Workfloor card ${reference(card)}`,
    label: `Card ${reference(card)}`,
    icon: "MessagesSquare",
    behavior: {
      kind: "action",
      onPress: async () => {
        const { url } = await client.rpc(readAddress, {});
        await openExternalUrl(cardUrl(url, card));
      },
    },
  });

  const drop = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const track = (agent: Agent) => {
    const card = agent.workspaceId && !agent.archivedAt ? cardOf(agent) : undefined;
    const existing = pills.get(agent.id);
    if (existing?.card === card) return;
    drop(agent.id);
    if (!card || !agent.workspaceId) return;
    pills.set(agent.id, {
      card,
      registration: client.addComposerPill({
        id: "workfloor-card",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: button(card),
      }),
    });
  };

  // ponytail: only the newest 200 agents get pills, as no-mistakes' pill does; page further if an old one needs it.
  void client.paseo.agents
    .list({
      subscribe: {},
      signal: lifetime.signal,
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200 },
    })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of pills.keys()) if (!seen.has(agentId)) drop(agentId);
          for (const { agent } of entries) track(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "remove") drop(message.payload.agentId);
          else track(message.payload.agent);
        },
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted)
        console.error("[workfloor-provider] could not watch agents", error);
    });

  return () => {
    lifetime.abort();
    for (const agentId of pills.keys()) drop(agentId);
  };
}
