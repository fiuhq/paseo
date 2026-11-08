/**
 * Delivery: the agent's own compaction, asked for the way a person would.
 *
 * Paseo cannot compact a session on an agent's behalf — a Claude session started by the
 * daemon is a headless one, where the harness's own compact entry point refuses (measured
 * 2026-09-21: "compaction here runs inside a turn"). Sending `/compact` as a message does
 * work, because the harness runs it in-session: 27,123 tokens came back as 1,209.
 *
 * So this channel sends one message and nothing else. The facts it reads come from a
 * refreshed snapshot, because a handle only knows what it has been told.
 */

import type { PluginHookContext } from "@getpaseo/plugin/server";

import { CompactChannel, type AgentFacts } from "../shared/compaction.core";

/**
 * The daemon API, taken from the hook context the host hands this half — deliberately not
 * `import type { PaseoApi } from "@getpaseo/client"`.
 *
 * Only the `@getpaseo/plugin*` specifiers are supplied by the host and left external. Every
 * other package has to resolve on disk when the daemon builds the bundle, and a plugin
 * installed from Git is built in a bare checkout with no node_modules, so naming the client
 * package directly fails the install outright (measured 2026-09-21: `Could not resolve type
 * dependency "@getpaseo/client"`). A directory install off a developer's tree hides that,
 * because there the package is installed.
 */
type PaseoApi = PluginHookContext["paseo"];

/**
 * Provider id → the command that compacts it. CODE, not settings: a command here is one
 * that has been driven end to end, and a configurable table would let an unverified
 * provider be pointed at an unverified command with nothing to catch it.
 */
const COMMANDS: Readonly<Record<string, string>> = { claude: "/compact" };

export class SlashChannel extends CompactChannel {
  readonly kind = "slash";

  constructor(private readonly paseo: PaseoApi) {
    super();
  }

  /**
   * The provider's own command, or its base harness's. Paseo names a derived harness
   * `<base>-<label>` — `claude-work` is the same Claude Code binary under another profile —
   * so it compacts with its base's command.
   * An unrelated provider matches nothing and is skipped by name rather than guessed at.
   */
  private commandFor(provider: string): string | null {
    const exact = COMMANDS[provider];
    if (exact) return exact;
    const base = provider.split("-")[0];
    return base && base !== provider ? (COMMANDS[base] ?? null) : null;
  }

  supports(provider: string): boolean {
    return this.commandFor(provider) !== null;
  }

  async facts(agentId: string): Promise<AgentFacts | null> {
    const handle = this.paseo.agents.ref(agentId);
    await handle.refresh().catch(() => null);
    const snapshot = handle.current();
    if (!snapshot) return null;
    return {
      status: snapshot.status,
      usage: snapshot.lastUsage ?? {},
      pendingPermissions: snapshot.pendingPermissions?.length ?? 0,
      activeTurnId: snapshot.activeTurn?.turnId ?? null,
    };
  }

  async compact(agentId: string, provider: string): Promise<void> {
    const command = this.commandFor(provider);
    if (!command) throw new Error(`no compaction command for ${provider}`);
    await this.paseo.agents.ref(agentId).send(command);
  }
}
