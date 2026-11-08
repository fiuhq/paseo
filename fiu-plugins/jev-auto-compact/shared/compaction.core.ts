/**
 * `Compaction` — the whole decision behind compacting an agent at a finished turn:
 * eligibility, judgment, the once-only claim, and delivery, in one fluent chain.
 *
 *   await Compaction.at(event)
 *     .judge(judge).ledger(ledger).channel(channel).policy(policy)
 *     .settle(now)                        // → { kind: "compacted", score: 0.97, … }
 *
 * The three collaborators are abstract classes, so the chain runs against fakes with
 * zero IO in tests and against Jev, the disk and Paseo in the daemon. It decides and
 * reports; it never logs and never throws — the caller logs the outcome exactly once.
 */

import {
  describeTurn,
  readTurn,
  turnKey,
  type TimelineLike,
  type TurnView,
  type UsageLike,
} from "./turn.core";

/** Probabilities behind the two questions, as the judge reported them. */
export interface JudgeReading {
  readonly finished: number;
  readonly handsOn: number;
  readonly model: string;
}

export abstract class CompactJudge {
  abstract read(state: string): Promise<JudgeReading>;
}

/** What the agent's own runtime says right now — read again before delivering. */
export interface AgentFacts {
  readonly status: string;
  readonly usage: UsageLike;
  readonly pendingPermissions: number;
  readonly activeTurnId: string | null;
}

export abstract class CompactChannel {
  /** Named in the outcome so an unsupported provider is visible, never silent. */
  abstract readonly kind: string;
  abstract supports(provider: string): boolean;
  abstract facts(agentId: string): Promise<AgentFacts | null>;
  /** The provider comes from the event: a fresh handle knows nothing until it refreshes. */
  abstract compact(agentId: string, provider: string): Promise<void>;
}

export type SettledOutcome = "held" | "compacted" | "failed" | "skipped" | "dry-run";

export abstract class CompactLedger {
  /**
   * Records the key and answers whether THIS caller won it — the single mechanism that
   * decides whether a turn has been acted on, so there is no second place to keep in
   * step. A claim taken before any delivery is what stands between a replayed or
   * re-delivered event and a second `/compact`, so it must outlive a plugin reload and
   * a daemon restart.
   */
  abstract claim(agentId: string, key: string, at: number): Promise<boolean>;
  abstract settle(
    agentId: string,
    key: string,
    outcome: SettledOutcome,
    at: number,
    tokens: number | null,
  ): Promise<void>;
}

export interface CompactPolicy {
  /**
   * The score a turn must clear, measured against the judge rather than guessed: a
   * mid-task turn scores ~0.01, a finished discussion ~0.50, and a finished hands-on
   * turn 0.88–0.90 (the judge's own certainty tops out near 0.94 per question, so a
   * floor above ~0.92 can never fire). 0.85 admits the third class and nothing else.
   */
  readonly floor: number;
  /** No judgment below this measured context size — compaction would not pay for itself. */
  readonly minTokens: number;
  /**
   * …and not below this share of the window the runtime reports. Windows
   * here are 1M tokens, where any absolute floor small enough for a 200k session fires
   * at a tenth of the context; both rules apply, and neither substitutes for the other.
   */
  readonly minUsedRatio: number;
  /** Literals the redactor cannot recognise on its own: project, tenant and org names. */
  readonly redactWords: readonly string[];
  /** Judge and record, deliver nothing. The honest way to watch it before trusting it. */
  readonly dryRun: boolean;
}

export const DEFAULT_POLICY: CompactPolicy = {
  floor: 0.85,
  minTokens: 120_000,
  minUsedRatio: 0.6,
  redactWords: [],
  dryRun: false,
};

export type CompactOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "duplicate"; readonly key: string }
  | {
      readonly kind: "held";
      readonly key: string;
      readonly score: number;
      readonly floor: number;
      readonly model: string;
    }
  | {
      readonly kind: "dry-run";
      readonly key: string;
      readonly score: number;
      readonly floor: number;
      readonly model: string;
    }
  | {
      readonly kind: "compacted";
      readonly key: string;
      readonly score: number;
      readonly floor: number;
      readonly model: string;
      readonly usedTokens: number;
    }
  | { readonly kind: "failed"; readonly key: string; readonly error: string };

/** The turn-ended event, structurally: only what the decision reads. */
export interface TurnEndedLike {
  readonly agent: { readonly id: string; readonly provider: string };
  readonly turnId?: string | null;
  readonly outcome: { readonly kind: string };
  readonly timeline: readonly TimelineLike[];
}

/**
 * finished is the gate; hands-on work adds up to half again. A finished hands-on unit
 * scores near 1, a finished coordinating one near 0.5, unfinished work near 0 — the
 * composition compact-adviser measured against what people actually asked next.
 */
export function score(reading: JudgeReading): number {
  return reading.finished * (0.5 + 0.5 * reading.handsOn);
}

/** Why this turn is not a candidate, or `null` when it is. Pure: the whole cheap gate. */
export function ineligible(
  event: TurnEndedLike,
  view: TurnView,
  facts: AgentFacts,
  policy: CompactPolicy,
): string | null {
  if (event.outcome.kind !== "completed") return `turn ${event.outcome.kind}`;
  if (facts.status !== "idle") return `agent ${facts.status}`;
  if (facts.activeTurnId !== null) return "another turn is running";
  if (facts.pendingPermissions > 0) return `${facts.pendingPermissions} pending permission(s)`;
  // Only the exchange that just ended can still be in flight. A backgrounded call started
  // in it will deliver its result back into this session, and compacting in between leaves
  // that result landing in a summary — so it still refuses. A call left running in an
  // EARLIER exchange is a stranded entry, not work: nothing ages it out of an append-only
  // stream, so honouring it would refuse that agent every turn from then on. `view`
  // separates the two; `strandedTools` is reported to the judge and never acted on here.
  if (view.runningTools > 0) return `${view.runningTools} tool call(s) still running`;
  if (view.lastItemType === "compaction") return "just compacted";

  const used = facts.usage.contextWindowUsedTokens;
  if (typeof used !== "number" || !Number.isFinite(used)) return "context size unknown";
  if (used < policy.minTokens) return `context ${used} < ${policy.minTokens} tokens`;
  const max = facts.usage.contextWindowMaxTokens;
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0)
    return "context window size unknown";
  if (used / max < policy.minUsedRatio) {
    return `context ${Math.round((used / max) * 100)}% < ${Math.round(policy.minUsedRatio * 100)}% of the window`;
  }
  return null;
}

interface Parts {
  readonly event: TurnEndedLike;
  readonly judge: CompactJudge | null;
  readonly ledger: CompactLedger | null;
  readonly channel: CompactChannel | null;
  readonly policy: CompactPolicy;
  readonly current: () => boolean;
}

export class Compaction {
  private constructor(private readonly parts: Parts) {}

  static at(event: TurnEndedLike): Compaction {
    return new Compaction({
      event,
      judge: null,
      ledger: null,
      channel: null,
      policy: DEFAULT_POLICY,
      current: () => true,
    });
  }

  judge(judge: CompactJudge): Compaction {
    return new Compaction({ ...this.parts, judge });
  }

  ledger(ledger: CompactLedger): Compaction {
    return new Compaction({ ...this.parts, ledger });
  }

  channel(channel: CompactChannel): Compaction {
    return new Compaction({ ...this.parts, channel });
  }

  /** Answers whether this is still the agent's latest turn; asked again just before delivery. */
  current(current: () => boolean): Compaction {
    return new Compaction({ ...this.parts, current });
  }

  policy(policy: Partial<CompactPolicy>): Compaction {
    return new Compaction({ ...this.parts, policy: { ...this.parts.policy, ...policy } });
  }

  /** The state this turn would be judged on — the exact bytes that would leave the host. */
  async state(): Promise<string> {
    const { event, policy, channel } = this.parts;
    const view = readTurn(event.timeline);
    const facts = channel ? await channel.facts(event.agent.id) : null;
    return describeTurn(view, facts?.usage ?? {}, policy.redactWords);
  }

  /** Runs the decision to its end and reports what happened. Never throws. */
  async settle(now: number): Promise<CompactOutcome> {
    const { event, judge, ledger, channel, policy, current } = this.parts;
    if (!judge || !ledger || !channel) return { kind: "skipped", reason: "incomplete wiring" };
    if (!channel.supports(event.agent.provider)) {
      return {
        kind: "skipped",
        reason: `${event.agent.provider} has no ${channel.kind} compaction`,
      };
    }

    const view = readTurn(event.timeline);
    const key = turnKey(event.agent.id, event.turnId ?? null, view);
    try {
      const facts = await channel.facts(event.agent.id);
      if (!facts) return { kind: "skipped", reason: "agent is gone" };

      const reason = ineligible(event, view, facts, policy);
      if (reason) return { kind: "skipped", reason };

      // Claimed BEFORE the judge is asked: a crash between here and delivery costs this
      // one checkpoint, where a lost claim would cost a second compaction.
      if (!(await ledger.claim(event.agent.id, key, now))) return { kind: "duplicate", key };

      const reading = await judge.read(describeTurn(view, facts.usage, policy.redactWords));
      const value = score(reading);
      if (value < policy.floor) {
        await ledger.settle(event.agent.id, key, "held", now, null);
        return { kind: "held", key, score: value, floor: policy.floor, model: reading.model };
      }
      if (policy.dryRun) {
        await ledger.settle(event.agent.id, key, "dry-run", now, null);
        return { kind: "dry-run", key, score: value, floor: policy.floor, model: reading.model };
      }

      // The judge call takes a second or two; the person may have typed in the meantime.
      const before = await channel.facts(event.agent.id);
      if (
        !current() ||
        !before ||
        before.status !== "idle" ||
        before.activeTurnId !== null ||
        before.pendingPermissions > 0
      ) {
        await ledger.settle(event.agent.id, key, "skipped", now, null);
        return { kind: "skipped", reason: "the agent started working again" };
      }

      const used = before.usage.contextWindowUsedTokens ?? facts.usage.contextWindowUsedTokens ?? 0;
      await channel.compact(event.agent.id, event.agent.provider);
      await ledger.settle(event.agent.id, key, "compacted", now, used);
      return {
        kind: "compacted",
        key,
        score: value,
        floor: policy.floor,
        model: reading.model,
        usedTokens: used,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await ledger.settle(event.agent.id, key, "failed", now, null).catch(() => undefined);
      return { kind: "failed", key, error: message };
    }
  }
}
