import { randomUUID } from "node:crypto";
import { TimelineProjection, type ProjectedTimelineRow } from "./timeline-projection.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "./provider-subagents/store.js";

/** What a closed agent leaves besides its timeline, kept with it while it is released. */
export interface ReleaseTimelineOptions {
  providerSubagents?: readonly ProviderSubagentDescriptor[];
}

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface AgentTimelineState {
  epoch: string;
  projection: TimelineProjection;
  minSeq: number;
  nextSeq: number;
}
const DEFAULT_TIMELINE_FETCH_LIMIT = 200;
function cloneRow<T extends AgentTimelineRow>(row: T): T {
  return { ...row };
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId) || this.isReleased(agentId);
  }

  /**
   * Called when an agent's runtime closes. This store keeps the timeline in memory; a subclass may
   * move it elsewhere, and `load` brings it back.
   */
  async release(_agentId: string, _options?: ReleaseTimelineOptions): Promise<void> {}

  /** Brings a released timeline back into memory. Await it before reading a closed agent's timeline. */
  async load(_agentId: string): Promise<void> {}

  /** The head of a timeline, read without loading its agent; null when no timeline is held. */
  async peekHead(agentId: string): Promise<{ epoch: string; seq: number } | null> {
    return this.has(agentId) ? this.getHead(agentId) : null;
  }

  /** A timeline page, read without loading its agent; null when no timeline is held. */
  async peekFetch(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult | null> {
    return this.has(agentId) ? this.fetch(agentId, options) : null;
  }

  /** The last assistant message, read without loading its agent; null when there is none. */
  async peekLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.has(agentId) ? this.getLastAssistantMessage(agentId) : null;
  }

  /** The provider subagents released with a timeline this store no longer holds; null when none. */
  async peekProviderSubagents(_agentId: string): Promise<ProviderSubagentDescriptor[] | null> {
    return null;
  }

  /** Whether a released timeline is held outside memory until `load`. */
  protected isReleased(_agentId: string): boolean {
    return false;
  }

  /** Drops the in-memory state without touching anything a subclass holds elsewhere. */
  protected evict(agentId: string): void {
    this.states.delete(agentId);
  }

  /** The in-memory state object, so a subclass can tell whether it changed across an await. */
  protected resident(agentId: string): object | undefined {
    return this.states.get(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = rows.reduce((next, row) => Math.max(next, row.seq + 1), options?.nextSeq ?? 1);
    const projection = new TimelineProjection(rows);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      projection,
      minSeq: projection.getRows()[0]?.seqStart ?? 0,
      nextSeq,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId)
      .projection.getRows()
      .map((row) => row.item);
  }

  getRows(agentId: string): ProjectedTimelineRow[] {
    return this.requireState(agentId).projection.getRows().map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId)
      .projection.getRows()
      .find(
        (candidate) =>
          candidate.item.type === "user_message" &&
          candidate.item.clientMessageId === clientMessageId,
      );
    return row ? cloneRow(row) : null;
  }

  enrichSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    providerMessageId: string,
  ): AgentTimelineRow | null {
    return this.requireState(agentId).projection.enrichSubmittedUserMessage(
      clientMessageId,
      providerMessageId,
    );
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  getHead(agentId: string): { epoch: string; seq: number } {
    const state = this.requireState(agentId);
    return { epoch: state.epoch, seq: state.nextSeq - 1 };
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const hasRows = state.minSeq !== 0;
    const window = { minSeq: state.minSeq, maxSeq: state.nextSeq - 1, nextSeq: state.nextSeq };
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      hasRows &&
      cursor.seq < state.minSeq - 1;
    const reset = staleCursor || gap;
    const page = state.projection.selectPage({
      bounds: window,
      direction: reset ? "tail" : direction,
      cursorSeq: cursor?.seq,
      limit: options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT,
      wholeTurns: options?.wholeTurns,
    });
    return {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      // Stored rows are already within budget; this bounds assistant and reasoning merges.
      rows: page.entries.map((entry) =>
        Object.assign({ seq: entry.seqEnd }, entry, {
          item: limitAgentTimelineItemContent(entry.item),
        }),
      ),
    };
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
    };
    state.nextSeq += 1;
    if (state.minSeq === 0) state.minSeq = row.seq;
    state.projection.append(row);
    return cloneRow(row);
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.projection.getLastItem(state.nextSeq - 1);
  }

  getLastAssistantMessage(agentId: string): string | null {
    return this.requireState(agentId).projection.getLastAssistantMessage();
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state && this.isReleased(agentId)) {
      throw new Error(`The timeline of agent '${agentId}' was released; load it first`);
    }
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
