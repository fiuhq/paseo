/**
 * The one reading of every workspace's boards this client holds, and the loop that refreshes it. The panels and the
 * header buttons read it with `useSyncExternalStore`, so N open workspaces cost one read, not N.
 *
 * It re-reads every few seconds while the page is visible: the plugin SDK has no daemon-pushed subscription, and one
 * read is a stat per registered board. A reading never opens anything; only the reader opens the panel.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

import type { WorkspaceBoards } from "../shared/boards";
import { readBoards } from "../shared/contracts";

export interface BoardsReading {
  /** Every workspace's boards; null until the first read answers. */
  readonly workspaces: WorkspaceBoards | null;
  /** Every workspace the host has, boards or not: each carries the header button. */
  readonly workspaceIds: readonly string[];
  /** Why the last read failed; null when it answered. */
  readonly error: string | null;
}

export class BoardsStore {
  private reading: BoardsReading = { workspaces: null, workspaceIds: [], error: null };
  private readonly listeners = new Set<() => void>();

  readonly get = (): BoardsReading => this.reading;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(next: BoardsReading): void {
    // An unchanged reading keeps its identity, so nothing that reads it renders again.
    if (JSON.stringify(next) === JSON.stringify(this.reading)) return;
    this.reading = next;
    for (const listener of this.listeners) listener();
  }
}

/** The page's visibility on web; a native client has no document and is always read. */
const page = globalThis as { document?: { hidden?: boolean } };

/** How often the boards are read while the page is visible. */
export const BOARDS_EVERY_MS = 4_000;

/** Keep `store` read from this host until the returned function is called. */
export function readBoardsInto(
  store: BoardsStore,
  client: Pick<PluginClientContext, "rpc">,
  every: number = BOARDS_EVERY_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    // A hidden tab shows no board: skip the read and look again later.
    if (page.document?.hidden !== true) {
      try {
        const { workspaces, workspaceIds } = await client.rpc(readBoards, {});
        if (!stopped) store.set({ workspaces, workspaceIds, error: null });
      } catch (error) {
        if (!stopped)
          store.set({
            ...store.get(),
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
    if (!stopped) timer = setTimeout(tick, every);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
