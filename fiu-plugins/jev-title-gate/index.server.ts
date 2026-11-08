import os from "node:os";
import path from "node:path";

import { JevTitleJudge } from "./server/jev-title-judge";
import type { TitleRequest } from "./shared/title-gate.core";

/**
 * jev-title-gate
 *
 * Registering `workspace.title.before` is what makes Paseo hold a new workspace's title:
 * the row reads `Naming…` until a candidate passes here. A refused guess is dropped and
 * Paseo writes the next one from the agent's reply, once the agent has actually read the
 * link. The plugin decides nothing else.
 *
 * Logs: `paseo plugin logs jev-title-gate`.
 */
interface TitleHookServer {
  addHook(
    name: "workspace.title.before",
    handler: (payload: { request: TitleRequest }) => Promise<TitleRequest>,
  ): () => void;
}

export default function contribute(server: TitleHookServer) {
  const judge = new JevTitleJudge(path.join(os.homedir(), ".local", "bin", "fiu"), 20_000);

  return server.addHook("workspace.title.before", async ({ request }) => {
    const verdict = await judge.verdict(
      request.candidate.title,
      request.source,
      request.sourceText,
    );
    console.error(
      `[jev-title-gate] ${verdict.decision} (${verdict.score ?? "no score"}) try ${request.attempt} from ${request.source}`,
    );
    return { ...request, verdict };
  });
}
