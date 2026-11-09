import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

import { HostBoards, readAllPages } from "./server/boards";
import { readBoardPage, readBoards } from "./shared/contracts";

/**
 * fiu-storyboard
 *
 * The daemon half of the fiu.Storyboard panel: each workspace's boards on this host, read from fiu's board registry
 * (`server/registry.ts`, read only), placed in a workspace by the agent that wrote each, and one board's page by its id.
 * It keeps no state. Logs: `paseo plugin logs fiu-storyboard`.
 */

/** How many agents or workspaces it reads: the newest pages, well past what one host keeps. */
const READ_MAX = 5_000;

export default function contribute(server: PluginServerContext) {
  // The agents are read through the session a handler is given, the only Paseo API the daemon half has.
  let paseo: PluginHandlerContext["paseo"] | null = null;
  const boards = new HostBoards(
    async () => {
      if (!paseo) throw new Error("no Paseo session yet to read the agents with");
      const session = paseo;
      const entries = await readAllPages(
        (page) => session.agents.list({ filter: { includeArchived: true }, page }),
        READ_MAX,
      );
      return entries.map(({ agent }) => ({ id: agent.id, workspaceId: agent.workspaceId ?? null }));
    },
    undefined,
    undefined,
    async () => {
      if (!paseo) return [];
      const session = paseo;
      return (await readAllPages((page) => session.workspaces.list({ page }), READ_MAX)).map(
        (workspace) => workspace.id,
      );
    },
  );
  server.handle(readBoards, (_input, context) => {
    paseo = context.paseo;
    return boards.read();
  });
  server.handle(readBoardPage, ({ board }) => boards.page(board));
  return () => {};
}
