import type { PluginServerContext } from "@getpaseo/plugin/server";
import { stopClaudeSession } from "./server/stop-session";

/**
 * workspace-agent-guard
 *
 * Operator 2026-09-16: "if u create a new paseo task, it must have an initializing agent with the
 * same effort … MANDATORY HOOK" and "upsert agentsmd to avoid pollers as much as possible, i
 * fucking hate them".
 *
 * Enforces ONE invariant, entirely event-driven — no timers, no polling:
 *
 *   AN INITIATOR MUST MATCH ITS CREATOR. `agent.created` exposes `parentAgentId`; if the new
 *   agent's `model` or `thinkingOptionId` differs from its parent's, the guard stops it and logs:
 *   it ends the child's Claude process (server/stop-session.ts), and stops each later turn as it
 *   starts until the child's settings match. It never archives: only the operator archives
 *   (operator, 2026-10-28), and an archived child left the workspace looking empty.
 *
 * Why no empty-workspace poller: Paseo has no single call that creates a WORKTREE workspace and its
 * agent together — `paseo run --new-workspace worktree …` was measured 2026-09-16 to send
 * `workspace.create` (source=worktree, NO firstAgentContext) then a separate `agent.create`, and
 * `paseo run` exposes no flag to pass the first-agent context. Rejecting a bare `workspace.create`
 * would therefore break the only path an AGENT has to create a worktree task, and only the Paseo
 * APP's "New Agent" passes `firstAgentContext` (a genuine one-call create). So the empty-workspace
 * rule is a workflow rule (create the workspace and its agent in ONE command), not a daemon timer.
 *
 * Logs: `paseo plugin logs workspace-agent-guard`.
 */

export default function contribute(server: PluginServerContext) {
  // Children found mismatched; each new turn is re-checked against the child's current settings.
  // ponytail: in memory, so a daemon restart forgets them; persist the set if mismatched children resurface.
  const mismatched = new Map<string, string>();

  server.on("agent.turn_started", (event, { paseo }) => {
    const parentId = mismatched.get(event.agent.id);
    if (!parentId) return;
    void (async () => {
      const child = await paseo.agents
        .ref(event.agent.id)
        .refresh()
        .then((r) => r?.agent ?? null)
        .catch(() => null);
      const parent = await paseo.agents
        .ref(parentId)
        .refresh()
        .then((r) => r?.agent ?? null)
        .catch(() => null);
      // An unreadable side says nothing: keep the child on the list and stop this turn anyway.
      const mismatch = parent && child ? differences(parent, child) : ["settings unreadable"];
      if (mismatch.length === 0) {
        mismatched.delete(event.agent.id);
        return;
      }
      const pids = await stopClaudeSession(event.agent.id);
      console.error(
        `[workspace-agent-guard] stopped initiator ${event.agent.id} again as its turn started (${pids.join(", ") || "no process"}): ${mismatch.join(", ")}`,
      );
    })().catch((error: unknown) =>
      console.error(
        `[workspace-agent-guard] turn-start re-check failed for ${event.agent.id}: ${String(error)}`,
      ),
    );
  });

  server.on("agent.created", (event, { paseo }) => {
    void (async () => {
      const child = event.agent;
      const parentId = child.parentAgentId;
      if (!parentId) return;

      try {
        const parentHandle = paseo.agents.ref(parentId);
        let parent = parentHandle.current();
        if (!parent) {
          await parentHandle.refresh().catch(() => null);
          parent = parentHandle.current();
        }
        if (!parent) return;

        const childHandle = paseo.agents.ref(child.id);
        let snapshot = childHandle.current();
        if (!snapshot) {
          await childHandle.refresh().catch(() => null);
          snapshot = childHandle.current();
        }

        const mismatch = differences(parent, snapshot);
        if (mismatch.length === 0) return;

        mismatched.set(child.id, parentId);
        const pids = await stopClaudeSession(child.id);
        console.error(
          `[workspace-agent-guard] stopped initiator ${child.id} (${pids.join(", ") || "no process yet; its first turn is stopped as it starts"}): does not match creator ${parentId} (${mismatch.join(", ")})`,
        );
      } catch (error: unknown) {
        console.error(
          `[workspace-agent-guard] initiator-match check failed for ${child.id}: ${String(error)}`,
        );
      }
    })();
  });

  return () => {};
}

type Settings =
  | { readonly model?: string | null; readonly thinkingOptionId?: string | null }
  | null
  | undefined;

/** How a child's model and effort differ from its creator's; empty when they match. */
export function differences(parent: Settings, child: Settings): string[] {
  const parentModel = parent?.model ?? null;
  const parentThinking = parent?.thinkingOptionId ?? null;
  const childModel = child?.model ?? null;
  const childThinking = child?.thinkingOptionId ?? null;
  const mismatch: string[] = [];
  if (parentModel && childModel && childModel !== parentModel)
    mismatch.push(`model ${childModel} != ${parentModel}`);
  if (parentThinking && childThinking !== parentThinking)
    mismatch.push(`thinkingOptionId ${childThinking ?? "(none)"} != ${parentThinking}`);
  return mismatch;
}
