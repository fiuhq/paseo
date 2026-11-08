import os from "node:os";

import type { PluginServerContext } from "@getpaseo/plugin/server";

import { Compaction } from "./shared/compaction.core";
import { FileLedger } from "./server/file-ledger";
import { JevJudge } from "./server/jev-judge";
import { SlashChannel } from "./server/slash-channel";
import { PLUGIN_HOME, SETTINGS_FILE, SettingsFile } from "./server/settings";

/**
 * jev-auto-compact
 *
 * Compacts an agent when its work is FINISHED, so the summary is written at a seam
 * instead of wherever the context window happened to run out mid-task.
 *
 * Every ended turn is described abstractly (counts, tool names, the last two messages,
 * redacted and clipped), and Jev answers two questions about it in one call: is this a
 * finished unit of work, and was it hands-on. A turn only earns `/compact` when the
 * combined score clears the floor, the context is genuinely large, and the agent is
 * sitting idle — and a turn is acted on at most once, however often the daemon replays
 * it, because the claim is a file the filesystem can only create for one caller.
 *
 * No timers, no polling, no agents created: one event, one judgment, one message.
 *
 * Settings: ~/.paseo/jev-auto-compact/settings.json (see README.md).
 * Logs: `paseo plugin logs jev-auto-compact`.
 */
export default function contribute(server: PluginServerContext) {
  const settingsFile = new SettingsFile();
  const ledger = new FileLedger(PLUGIN_HOME);
  const queues = new Map<string, Promise<unknown>>();
  const latest = new Map<string, number>();
  let disabledReason: string | null = null;

  server.on("agent.turn_ended", (event, { paseo }) => {
    // One decision at a time per agent: two overlapping turns must not both judge, and
    // the second must see the first one's claim.
    const agentId = event.agent.id;
    const mine = (latest.get(agentId) ?? 0) + 1;
    latest.set(agentId, mine);
    const work = async () => {
      const read = await settingsFile.read();
      if (read.error !== null) {
        if (read.changed)
          console.error(`[jev-auto-compact] disabled — ${SETTINGS_FILE}: ${read.error}`);
        return;
      }
      const settings = read.settings;
      if (read.changed && disabledReason === null)
        console.error(`[jev-auto-compact] settings reloaded from ${SETTINGS_FILE}`);
      if (!settings.enabled) {
        if (disabledReason !== "settings") console.error("[jev-auto-compact] disabled by settings");
        disabledReason = "settings";
        return;
      }
      disabledReason = null;
      if (settings.agents.length > 0 && !settings.agents.includes(agentId)) {
        if (settings.debug)
          console.error(`[jev-auto-compact] skipped ${agentId} — outside the configured scope`);
        return;
      }

      if (settings.debug) {
        // Types and statuses only — no content. The shape of a delivered timeline is the
        // one thing no type definition pins down, and every gate here reads it.
        const shape = event.timeline
          .slice(-12)
          .map((item) => {
            const record = item as {
              type: string;
              status?: unknown;
              callId?: unknown;
              messageId?: unknown;
            };
            const id =
              typeof record.callId === "string"
                ? record.callId
                : typeof record.messageId === "string"
                  ? record.messageId
                  : null;
            return `${record.type}${typeof record.status === "string" ? `:${record.status}` : ""}${id ? `#${id.slice(-6)}` : "#-"}`;
          })
          .join(" ");
        console.error(
          `[jev-auto-compact] timeline ${agentId} (${event.timeline.length} items): ${shape}`,
        );
      }

      const chain = Compaction.at(event)
        .judge(new JevJudge(settings.jevBin, settings.jevTimeoutMs, os.homedir()))
        .ledger(ledger)
        .channel(new SlashChannel(paseo))
        .current(() => latest.get(agentId) === mine)
        .policy(settings.policy);
      const outcome = await chain.settle(Date.now());

      // Under debug, show what the judge actually read whenever it was asked: a score
      // is only auditable next to the state it scored.
      if (
        settings.debug &&
        (outcome.kind === "held" || outcome.kind === "dry-run" || outcome.kind === "compacted")
      ) {
        console.error(`[jev-auto-compact] state ${agentId}\n${await chain.state()}`);
      }

      // The Impl decides and reports; this is the one place any of it is written down.
      switch (outcome.kind) {
        case "compacted":
          console.error(
            `[jev-auto-compact] compacted ${agentId} at ${outcome.usedTokens} tokens — score ${outcome.score.toFixed(2)} >= ${outcome.floor} (${outcome.model})`,
          );
          break;
        case "dry-run":
          console.error(
            `[jev-auto-compact] would compact ${agentId} — score ${outcome.score.toFixed(2)} >= ${outcome.floor} (${outcome.model}), dry run`,
          );
          break;
        case "failed":
          console.error(`[jev-auto-compact] failed on ${agentId}: ${outcome.error}`);
          break;
        case "held":
          if (settings.debug)
            console.error(
              `[jev-auto-compact] held ${agentId} — score ${outcome.score.toFixed(2)} < ${outcome.floor} (${outcome.model})`,
            );
          break;
        case "duplicate":
          if (settings.debug) console.error(`[jev-auto-compact] already handled ${outcome.key}`);
          break;
        default:
          if (settings.debug)
            console.error(`[jev-auto-compact] skipped ${agentId} — ${outcome.reason}`);
          break;
      }
    };

    const next = (queues.get(agentId) ?? Promise.resolve()).then(work, work);
    queues.set(
      agentId,
      next.catch((error: unknown) =>
        console.error(`[jev-auto-compact] handler error on ${agentId}: ${String(error)}`),
      ),
    );
  });

  return () => {};
}
