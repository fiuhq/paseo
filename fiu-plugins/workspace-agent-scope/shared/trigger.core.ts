/**
 * PURE: one serialized runner that collapses bursts. Paseo can create or archive several workspaces at once; each event
 * only needs the scope reconciled after it, so a run already in flight absorbs every event that arrives while it runs
 * into exactly one follow-up run.
 */
export class CoalescingRunner {
  private running = false;
  private pending = false;

  constructor(private readonly run: () => Promise<void>) {}

  /**
   * Ask for a run; resolves once the run that covers this request has finished. A request that arrives during a run is
   * served by the follow-up run even when the run before it failed: that follow-up answers a later event, so it is not a
   * retry. The first failure is rethrown once every requested run is done.
   */
  async request(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    let failure: { readonly error: unknown } | null = null;
    try {
      do {
        this.pending = false;
        try {
          await this.run();
        } catch (error) {
          failure ??= { error };
        }
      } while (this.pending);
    } finally {
      this.running = false;
    }
    if (failure !== null) throw failure.error;
  }
}

/** What waiting on a directory's removal touches: whether a path exists, and a watch on a directory's entries. */
export interface RemovalPorts {
  exists(dir: string): boolean;
  /** Watch `dir`'s entries; `onChange` on any change, `onError` when the watch breaks. Returns the stop. */
  watch(dir: string, onChange: () => void, onError: (error: Error) => void): () => void;
  /** The directory holding `dir`. A port, not node:path, so this file stays in Paseo's client-safe shared bundle. */
  parent(dir: string): string;
}

/**
 * Call `then` once `dir` is gone: at once when it already is, otherwise on the change to its parent that removes it. A
 * directory that stays (a workspace Paseo archives without removing its checkout) never calls it. `onError` gets a watch
 * that cannot start or breaks, and the wait ends there. Returns the stop.
 */
export function whenRemoved(
  dir: string,
  ports: RemovalPorts,
  then: () => void,
  onError: (error: Error) => void,
): () => void {
  if (!ports.exists(dir)) {
    then();
    return () => {};
  }
  let settled = false;
  let stop: () => void = () => {};
  const settle = (outcome: () => void) => {
    if (settled) return;
    settled = true;
    stop();
    outcome();
  };
  try {
    stop = ports.watch(
      ports.parent(dir),
      () => {
        if (!ports.exists(dir)) settle(then);
      },
      (error) => settle(() => onError(error)),
    );
  } catch (error) {
    settle(() => onError(error instanceof Error ? error : new Error(String(error))));
    return () => {};
  }
  // Removed between the first look and the watch starting: no change will come for it.
  if (!ports.exists(dir)) settle(then);
  return () => settle(() => {});
}
