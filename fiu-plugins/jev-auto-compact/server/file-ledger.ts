/**
 * The ledger on disk. Its one job is that a turn is acted on AT MOST ONCE, across a
 * replayed event, a plugin reload, a daemon restart and two daemons sharing a home.
 *
 * The claim is therefore not a read-modify-write of a JSON file — two of those racing
 * both "win". It is `open(path, "wx")`: the filesystem creates the claim file for
 * exactly one caller and fails the other with EEXIST. The log next to it is a
 * plain append-only history of outcomes.
 *
 * …and a rename moves that home, which is the one way a claim can go missing without
 * anything failing, so an agent's folder is carried over from the pre-rename home the
 * first time it is touched here.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CompactLedger, type SettledOutcome } from "../shared/compaction.core";
import { LEGACY_PLUGIN_HOME } from "./settings";

/** Agent ids are daemon uuids; this keeps a surprising one from escaping the directory. */
function safeId(agentId: string): string {
  const cleaned = agentId.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length < 8) throw new Error(`unusable agent id: ${JSON.stringify(agentId)}`);
  return cleaned;
}

export class FileLedger extends CompactLedger {
  /** Serialises this process's writes per agent; the filesystem handles the rest. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** One carry-over attempt per agent per process; the copy on disk is what makes the next one a no-op. */
  private readonly carried = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly legacyDir: string | null = LEGACY_PLUGIN_HOME,
  ) {
    super();
  }

  private agentDir(agentId: string): string {
    return path.join(this.dir, "agents", safeId(agentId));
  }

  private claimPath(agentId: string, key: string): string {
    return path.join(
      this.agentDir(agentId),
      "claims",
      `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
    );
  }

  private queue<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(agentId) ?? Promise.resolve()).then(work, work);
    this.queues.set(
      agentId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * The pre-rename id had its own home, so a claim taken there is invisible under this one
   * and the turn it covers would be delivered a second time the first time the daemon
   * replays it. The agent's folder is therefore copied across once, before any claim is
   * decided: `force: false` skips anything already written under the current name, so a
   * node that has been running here keeps its own record and a second pass copies nothing.
   *
   * A failure is raised rather than swallowed. The caller turns it into a `failed` outcome
   * and delivers nothing, which is the only safe side of a ledger that cannot say whether
   * the turn was already acted on.
   */
  private carryOver(agentId: string): Promise<void> {
    const legacyDir = this.legacyDir;
    if (legacyDir === null) return Promise.resolve();
    const already = this.carried.get(agentId);
    if (already) return already;

    const work = fs
      .cp(path.join(legacyDir, "agents", safeId(agentId)), this.agentDir(agentId), {
        recursive: true,
        force: false,
        errorOnExist: false,
      })
      .catch((error: unknown) => {
        // Nothing under the old name is the ordinary case on a node that never ran it.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        // Not remembered as done, so the next turn tries again instead of running blind.
        this.carried.delete(agentId);
        throw error;
      });
    this.carried.set(agentId, work);
    return work;
  }

  async claim(agentId: string, key: string, at: number): Promise<boolean> {
    await this.carryOver(agentId);
    const file = this.claimPath(agentId, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      const handle = await fs.open(file, "wx");
      await handle.writeFile(JSON.stringify({ key, at }));
      await handle.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    return true;
  }

  async settle(
    agentId: string,
    key: string,
    outcome: SettledOutcome,
    at: number,
    tokens: number | null,
  ): Promise<void> {
    await this.queue(agentId, async () => {
      const dir = this.agentDir(agentId);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(
        path.join(dir, "log.jsonl"),
        `${JSON.stringify({ at, key, outcome, tokens })}\n`,
      );
    });
  }
}
