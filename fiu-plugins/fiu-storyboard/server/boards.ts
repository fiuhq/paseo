/**
 * The daemon half of the panel: every workspace's boards on this host, and one board's page.
 *
 * The boards come from fiu's board registry (`server/registry.ts`). A workspace's own board belongs to it by its path;
 * any other board to the workspace of the agent that wrote it, read from this daemon's agents. A page is read only by a
 * board id the registry names, never by a path the client sends.
 */
import { readFileSync, statSync } from "node:fs";

import { boardsByWorkspace, type WorkspaceBoards } from "../shared/boards";
import {
  BOARDS_FILE,
  boardPathOf,
  registeredBoards,
  WORKSPACE_BOARDS_DIR,
  workspaceOfBoardFile,
} from "./registry";

/** An agent as the panel needs it: which workspace it works in. */
export interface AgentPlace {
  readonly id: string;
  readonly workspaceId?: string | null;
}

/** How long the agents' and workspaces' reads are trusted before the daemon is asked again. */
const AGENTS_TTL_MS = 60_000;

/** The largest page the panel loads; a bigger board stays a file tab. */
export const PAGE_LIMIT_BYTES = 40 * 1024 * 1024;

export class HostBoards {
  /** The agents' workspaces as last read, and every owner the registry named then, known or not. */
  private places: {
    readonly at: number;
    readonly workspaceOf: Map<string, string>;
    readonly asked: Set<string>;
  } | null = null;
  /**
   * Every workspace id as last read. Each listing makes the daemon read every workspace's state, and every open client
   * reads the boards every few seconds, so the ids share the agents' cache instead of a listing per read.
   */
  private ids: { readonly at: number; readonly ids: readonly string[] } | null = null;

  constructor(
    /** Every agent of this daemon, archived ones too: a board outlives the agent that wrote it. */
    private readonly agents: () => Promise<readonly AgentPlace[]>,
    private readonly registry: string = BOARDS_FILE,
    private readonly now: () => number = Date.now,
    /** Every workspace this daemon has, so each gets the header button whether it has a board yet or not. */
    private readonly workspaceIds: () => Promise<readonly string[]> = async () => [],
    private readonly workspaceBoards: string = WORKSPACE_BOARDS_DIR,
  ) {}

  /** Every workspace's boards, newest first. */
  async read(): Promise<{ workspaces: WorkspaceBoards; workspaceIds: string[] }> {
    const boards = registeredBoards(this.registry);
    const owners = new Set(boards.flatMap((board) => (board.owner ? [board.owner] : [])));
    // An owner the last read never heard of wrote a board since: read the agents again. One it heard of and could not
    // place (an agent this daemon no longer has) does not ask again until the cache expires.
    const unasked =
      this.places !== null && [...owners].some((owner) => !this.places!.asked.has(owner));
    const places = await this.workspaces(unasked, owners);
    const workspaces = boardsByWorkspace(
      boards,
      (agent) => places.get(agent),
      modifiedAt,
      undefined,
      (file) => workspaceOfBoardFile(file, this.workspaceBoards),
    );
    return {
      workspaces,
      workspaceIds: [
        ...new Set([...(await this.knownWorkspaceIds(unasked)), ...Object.keys(workspaces)]),
      ],
    };
  }

  /** One board's page; null when the registry no longer names it or its file is gone. */
  page(board: string): { html: string; modifiedAt: number } | null {
    const file = boardPathOf(board, this.registry);
    if (!file) return null;
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.size > PAGE_LIMIT_BYTES) {
      throw new Error(
        `${file} is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${PAGE_LIMIT_BYTES / 1024 / 1024} MB the panel loads: open it as a file tab`,
      );
    }
    return { html: readFileSync(file, "utf8"), modifiedAt: stat.mtimeMs };
  }

  /** Every workspace id; read again once the cache expires, or with the agents when a board names a new owner. */
  private async knownWorkspaceIds(fresh: boolean): Promise<readonly string[]> {
    if (!fresh && this.ids && this.now() - this.ids.at < AGENTS_TTL_MS) return this.ids.ids;
    this.ids = { at: this.now(), ids: await this.workspaceIds() };
    return this.ids.ids;
  }

  private async workspaces(
    fresh: boolean,
    owners: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    if (!fresh && this.places && this.now() - this.places.at < AGENTS_TTL_MS)
      return this.places.workspaceOf;
    const workspaceOf = new Map<string, string>();
    for (const agent of await this.agents())
      if (agent.workspaceId) workspaceOf.set(agent.id, agent.workspaceId);
    this.places = { at: this.now(), workspaceOf, asked: new Set(owners) };
    return workspaceOf;
  }
}

function modifiedAt(file: string): number | null {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
}

type Page = { limit: number; cursor?: string };

/** Every entry of a list the daemon pages at most 200 at a time, up to `max`. */
export async function readAllPages<T>(
  read: (page: Page) => Promise<{
    entries: readonly T[];
    pageInfo: { hasMore: boolean; nextCursor?: string | null };
  }>,
  max: number,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await read({ limit: 200, ...(cursor ? { cursor } : {}) });
    all.push(...entries);
    cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
  } while (cursor && all.length < max);
  return all;
}
