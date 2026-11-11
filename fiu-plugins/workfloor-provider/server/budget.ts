/** Workfloor refuses a personal token past 120 requests in a clock minute, the refused ones included. */
export const WORKFLOOR_TOKEN_LIMIT_PER_MINUTE = 120;
const MINUTE_MS = 60_000;

type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One token's requests, shared by every caller: each takes a slot first, in the order it asked, so no
 * 60 s window ever holds more than `perMinute` of them. After a refusal nobody asks again until
 * Workfloor's minute is over, or until its Retry-After when it sends one.
 */
export class RequestBudget {
  private sent: number[] = [];
  private pausedUntil = 0;
  private line: Promise<void> = Promise.resolve();

  constructor(
    private readonly perMinute = WORKFLOOR_TOKEN_LIMIT_PER_MINUTE - 20,
    private readonly now: () => number = Date.now,
    private readonly wait: Sleep = sleep,
  ) {}

  take(): Promise<void> {
    const turn = this.line.then(() => this.slot());
    this.line = turn.catch(() => undefined);
    return turn;
  }

  refused(retryAfterMs?: number): void {
    const now = this.now();
    const nextMinute = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS + 2_000;
    this.pausedUntil = Math.max(
      this.pausedUntil,
      retryAfterMs === undefined ? nextMinute : now + retryAfterMs,
    );
  }

  private async slot(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.sent = this.sent.filter((at) => at > now - MINUTE_MS);
      const full = this.sent.length >= this.perMinute ? this.sent[0]! + MINUTE_MS : 0;
      const until = Math.max(this.pausedUntil, full);
      if (until <= now) {
        this.sent.push(now);
        return;
      }
      await this.wait(until - now);
    }
  }
}

/** Retry-After in ms, when Workfloor sends one (seconds or an HTTP date). */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
