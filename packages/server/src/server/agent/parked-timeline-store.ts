import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { writeFileAtomic } from "../atomic-file.js";
import {
  InMemoryAgentTimelineStore,
  type ReleaseTimelineOptions,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { ProviderSubagentDescriptor } from "./provider-subagents/store.js";

/**
 * Keeps the timeline of an agent whose runtime closed on disk instead of in daemon memory.
 *
 * An idle agent's runtime is closed after an hour, but its timeline stayed in memory, and reading it
 * resumed the whole agent. This store writes the timeline once, when the runtime closes, and drops it
 * from memory. A read of that agent (`peekHead`, `peekFetch`) parses the file for the one request and
 * keeps nothing. `load`, which a resume awaits, reads it back into memory and removes the file, so a
 * file always holds exactly what the agent had when it last stopped.
 *
 * Nothing is written while an agent runs: one file per release, never a rewrite per event (the write
 * amplification that took timelines off disk in getpaseo/paseo#3647).
 *
 * A file left by an earlier daemon run serves reads too, but never counts as `has`: a resume after a
 * restart still rebuilds the timeline from provider history, which stays the durable authority.
 */
export class ParkedTimelineStore extends InMemoryAgentTimelineStore {
  private readonly directory: string;
  private readonly logger: Pick<Logger, "warn" | "error">;
  /** Agents released by this daemon run whose timeline is only on disk. */
  private readonly parked = new Set<string>();
  /** Agents loaded since their release began; that release keeps the timeline in memory. */
  private readonly loadedDuringRelease = new Set<string>();
  /** File operations per agent, in order, so a removal never lands after a later write. */
  private readonly fileOps = new Map<string, Promise<void>>();

  constructor(options: { directory: string; logger: Pick<Logger, "warn" | "error"> }) {
    super();
    this.directory = options.directory;
    this.logger = options.logger;
  }

  override initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    super.initialize(agentId, options);
    // A new or restored timeline in memory supersedes any file for this agent.
    this.forget(agentId);
  }

  override delete(agentId: string): void {
    super.delete(agentId);
    this.loadedDuringRelease.delete(agentId);
    this.forget(agentId);
  }

  override async release(agentId: string, options?: ReleaseTimelineOptions): Promise<void> {
    const state = this.resident(agentId);
    const files = this.files(agentId);
    if (!state || !files) return;
    this.loadedDuringRelease.delete(agentId);
    const head = this.getHead(agentId);
    const snapshot: ParkedTimeline = {
      version: 1,
      epoch: head.epoch,
      nextSeq: head.seq + 1,
      rows: this.getRows(agentId),
      providerSubagents: [...(options?.providerSubagents ?? [])],
    };
    await this.enqueue(agentId, async () => {
      try {
        await writeFileAtomic(files.rows, JSON.stringify(snapshot));
        await writeFileAtomic(files.head, JSON.stringify({ epoch: head.epoch, seq: head.seq }));
      } catch (error) {
        // The timeline stays in memory: a failed write costs memory, never history.
        this.logger.warn({ err: error, agentId }, "Failed to park an agent timeline on disk");
        await removeFiles(files);
        return;
      }
      if (
        this.loadedDuringRelease.has(agentId) ||
        this.resident(agentId) !== state ||
        this.getHead(agentId).seq !== head.seq
      ) {
        // The agent came back while the file was being written; memory is the newer copy.
        await removeFiles(files);
        return;
      }
      this.evict(agentId);
      this.parked.add(agentId);
    });
  }

  override async peekHead(agentId: string): Promise<{ epoch: string; seq: number } | null> {
    await this.fileOps.get(agentId);
    if (this.resident(agentId)) return this.getHead(agentId);
    const files = this.files(agentId);
    if (!files) return null;
    const head = await this.readJson(agentId, files.head);
    return isHead(head) ? head : null;
  }

  override async peekFetch(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult | null> {
    const reader = await this.reader(agentId);
    return reader ? reader.fetch(agentId, options) : null;
  }

  override async peekProviderSubagents(
    agentId: string,
  ): Promise<ProviderSubagentDescriptor[] | null> {
    await this.fileOps.get(agentId);
    if (this.resident(agentId)) return null;
    const parkedTimeline = await this.readParked(agentId);
    return parkedTimeline ? (parkedTimeline.providerSubagents ?? []) : null;
  }

  /** This store when the timeline is in memory, else one built from its file for a single read. */
  private async reader(agentId: string): Promise<InMemoryAgentTimelineStore | null> {
    await this.fileOps.get(agentId);
    if (this.resident(agentId)) return this;
    const parkedTimeline = await this.readParked(agentId);
    if (!parkedTimeline) return null;
    const reader = new InMemoryAgentTimelineStore();
    reader.initialize(agentId, seedOf(parkedTimeline));
    return reader;
  }

  override async peekItems(agentId: string): Promise<AgentTimelineItem[] | null> {
    const reader = await this.reader(agentId);
    return reader ? reader.getItems(agentId) : null;
  }

  protected override isReleased(agentId: string): boolean {
    return this.parked.has(agentId);
  }

  override async load(agentId: string): Promise<void> {
    if (this.fileOps.has(agentId)) this.loadedDuringRelease.add(agentId);
    await this.fileOps.get(agentId);
    if (!this.parked.has(agentId)) return;
    const parkedTimeline = await this.readParked(agentId);
    if (!this.parked.has(agentId)) return;
    if (parkedTimeline) {
      this.initialize(agentId, seedOf(parkedTimeline));
      return;
    }
    // Without the file the agent rebuilds its timeline from provider history on resume.
    this.logger.error({ agentId }, "Failed to restore a parked agent timeline");
    this.forget(agentId);
    await this.fileOps.get(agentId);
  }

  /** The parked file of an agent; null when there is none or it is not a parked timeline. */
  private async readParked(agentId: string): Promise<ParkedTimeline | null> {
    const files = this.files(agentId);
    const parkedTimeline = files ? await this.readJson(agentId, files.rows) : null;
    return isParkedTimeline(parkedTimeline) ? parkedTimeline : null;
  }

  /** A parked file's JSON; null when there is none. A file that cannot be parsed is reported. */
  private async readJson(agentId: string, filePath: string): Promise<unknown> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          { err: error, agentId, filePath },
          "Failed to read a parked agent timeline",
        );
      }
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      this.logger.warn(
        { err: error, agentId, filePath },
        "A parked agent timeline file is not valid JSON",
      );
      return null;
    }
  }

  private forget(agentId: string): void {
    this.parked.delete(agentId);
    const files = this.files(agentId);
    if (!files) return;
    void this.enqueue(agentId, () => removeFiles(files)).catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Failed to remove a parked agent timeline");
    });
  }

  private enqueue(agentId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.fileOps.get(agentId) ?? Promise.resolve()).then(operation, operation);
    const settled = next.catch(() => undefined);
    this.fileOps.set(agentId, settled);
    void settled.then(() => {
      if (this.fileOps.get(agentId) === settled) this.fileOps.delete(agentId);
      return undefined;
    });
    return next;
  }

  /** The two files of an agent's parked timeline, or null for an id that is not a safe file name. */
  private files(agentId: string): ParkedFiles | null {
    if (!SAFE_AGENT_ID.test(agentId)) return null;
    return {
      rows: path.join(this.directory, `${agentId}.json`),
      head: path.join(this.directory, `${agentId}.head.json`),
    };
  }
}

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface ParkedFiles {
  rows: string;
  head: string;
}

interface ParkedTimeline {
  version: 1;
  epoch: string;
  nextSeq: number;
  rows: AgentTimelineRow[];
  /** Absent in a file written before subagents were parked; read as none. */
  providerSubagents?: ProviderSubagentDescriptor[];
}

function seedOf(parkedTimeline: ParkedTimeline): SeedAgentTimelineOptions {
  return {
    epoch: parkedTimeline.epoch,
    nextSeq: parkedTimeline.nextSeq,
    rows: parkedTimeline.rows,
  };
}

function isHead(value: unknown): value is { epoch: string; seq: number } {
  if (typeof value !== "object" || value === null) return false;
  const { epoch, seq } = value as { epoch?: unknown; seq?: unknown };
  return typeof epoch === "string" && typeof seq === "number";
}

function isParkedTimeline(value: unknown): value is ParkedTimeline {
  if (typeof value !== "object" || value === null) return false;
  const { version, epoch, nextSeq, rows, providerSubagents } = value as Partial<
    Record<keyof ParkedTimeline, unknown>
  >;
  return (
    version === 1 &&
    typeof epoch === "string" &&
    typeof nextSeq === "number" &&
    Array.isArray(rows) &&
    (providerSubagents === undefined || Array.isArray(providerSubagents))
  );
}

async function removeFiles(files: ParkedFiles): Promise<void> {
  await fs.rm(files.head, { force: true });
  await fs.rm(files.rows, { force: true });
}
