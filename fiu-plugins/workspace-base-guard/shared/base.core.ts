/**
 * Pure decision logic for the base-ref guard. No IO — the caller supplies the
 * facts it gathered from git, so every rule here is unit-testable.
 *
 * WHY: Paseo resolves a bare branch name LOCAL-FIRST (`refs/heads/<name>` before
 * `refs/remotes/origin/<name>`), so a request naming `release/V3` can cut a
 * worktree from a local branch many commits behind the remote. Its own docs say
 * "Use `origin/main` rather than `main`", and it was measured against the live
 * daemon on 2026-09-17: `baseBranch: "release/V3"` produced the local tip (24
 * commits behind) while `origin/release/V3` produced the fetched remote tip.
 * A request with NO base at all is worse: `resolveDefaultBranch` prefers the local
 * name whenever that branch exists.
 *
 * SAFETY RULE: qualify only when origin is at least as new. If the local branch
 * holds commits origin does not, the local branch is the more complete history and
 * is kept — this guard must never discard unpushed work.
 */

export interface BranchFacts {
  readonly hasOrigin: boolean;
  readonly hasLocal: boolean;
  /** Commits on the local branch that origin does not have; null when unknown. */
  readonly ahead: number | null;
}

export interface BaseRefFacts {
  /** Configured remote names, so `<remote>/x` is never read as a plain branch. */
  readonly remoteNames: readonly string[];
  /** Facts for the branch names this request could resolve to. */
  readonly branches: ReadonlyMap<string, BranchFacts>;
}

export type BaseRefPlan =
  | {
      readonly action: "qualify";
      readonly from: string;
      readonly to: string;
      readonly reason: string;
    }
  | { readonly action: "keep"; readonly from: string; readonly reason: string }
  | { readonly action: "absent" };

/**
 * Decide whether a requested base ref should become its origin-qualified form.
 *
 * Kept when already exact (`refs/…`) or already remote-qualified; kept when the
 * branch is unknown, origin-less, or strictly ahead of origin.
 */
export function planBaseRef(
  requested: string | null | undefined,
  facts: BaseRefFacts,
): BaseRefPlan {
  const from = requested?.trim() ?? "";
  if (from.length === 0) return { action: "absent" };
  if (from.startsWith("refs/")) return { action: "keep", from, reason: "already an exact ref" };

  const slash = from.indexOf("/");
  if (slash > 0) {
    const head = from.slice(0, slash);
    if (head === "origin" || facts.remoteNames.includes(head)) {
      return { action: "keep", from, reason: `already qualified by remote '${head}'` };
    }
  }

  const branch = facts.branches.get(from);
  if (!branch)
    return {
      action: "keep",
      from,
      reason: "branch facts unavailable; leaving the request untouched",
    };
  if (!branch.hasOrigin)
    return { action: "keep", from, reason: "no origin counterpart; keeping the local branch" };
  if (branch.hasLocal && (branch.ahead ?? 0) > 0) {
    return {
      action: "keep",
      from,
      reason: `local branch has ${branch.ahead} unpushed commit(s); keeping it`,
    };
  }
  return {
    action: "qualify",
    from,
    to: `origin/${from}`,
    reason: branch.hasLocal ? "local branch is not ahead of origin" : "only origin has this branch",
  };
}

export interface RewriteInput {
  readonly action?: string | null;
  readonly refName?: string | null;
  readonly baseBranch?: string | null;
  readonly hasCheckoutSource?: boolean;
}

/**
 * Only `branch-off` choosing a base is in scope. A checkout names an exact commit
 * stream already; a change request is fetched by ref from its own remote.
 */
export function shouldGuard(input: RewriteInput): boolean {
  if (input.hasCheckoutSource) return false;
  return input.action !== "checkout";
}

/**
 * Every branch name this request could resolve to, so the daemon gathers facts only
 * for what it needs instead of walking every branch in a large repo.
 *
 * A bare branch may legitimately contain slashes (`release/V3`, `feat/x`), so the
 * only names skipped are exact refs and refs already qualified by a known remote.
 */
export function candidateBranches(
  request: {
    readonly refName?: string | null;
    readonly baseBranch?: string | null;
  },
  remoteNames: readonly string[] = [],
): string[] {
  const out: string[] = [];
  for (const value of [request.refName, request.baseBranch]) {
    const name = value?.trim() ?? "";
    if (name.length === 0 || name.startsWith("refs/")) continue;
    const head = name.slice(0, name.indexOf("/") === -1 ? name.length : name.indexOf("/"));
    if (head === "origin" || remoteNames.includes(head)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface RewriteResult {
  readonly refName?: string;
  readonly baseBranch?: string;
  readonly rewrites: readonly {
    readonly field: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly kept: readonly {
    readonly field: string;
    readonly from: string;
    readonly reason: string;
  }[];
}

/**
 * Apply the plan to both base-bearing fields. Paseo prefers `refName` when it is
 * present, so a request carrying both must be rewritten in both or one silently
 * overrides the guard.
 */
export function rewriteBaseRefs(
  input: { readonly refName?: string | null; readonly baseBranch?: string | null },
  facts: BaseRefFacts,
): RewriteResult {
  const rewrites: { field: string; from: string; to: string }[] = [];
  const kept: { field: string; from: string; reason: string }[] = [];
  const out: { refName?: string; baseBranch?: string } = {};

  for (const field of ["refName", "baseBranch"] as const) {
    const requested = input[field];
    const plan = planBaseRef(requested, facts);
    if (plan.action === "qualify") {
      out[field] = plan.to;
      rewrites.push({ field, from: plan.from, to: plan.to });
    } else {
      if (plan.action === "keep") kept.push({ field, from: plan.from, reason: plan.reason });
      const trimmed = requested?.trim();
      if (trimmed) out[field] = trimmed;
    }
  }

  return { ...out, rewrites, kept };
}
export interface CorrectDecisionInput {
  /** Whether a Paseo worktree metadata file exists for this worktree. */
  readonly hasMetadata: boolean;
  /** The base branch recorded in that metadata, if any. */
  readonly baseBranch: string | null;
  /** Whether `refs/remotes/origin/<baseBranch>` exists. */
  readonly hasOriginBase: boolean;
  /** Worktree HEAD equals the origin base tip. */
  readonly atOriginHead: boolean;
  /** Worktree HEAD is an ancestor of the origin base tip (origin is ahead). */
  readonly behindOrigin: boolean;
  /** Tracked files modified in the worktree. */
  readonly dirty: boolean;
}

export type CorrectDecision =
  | { readonly action: "reset"; readonly target: string; readonly reason: string }
  | { readonly action: "skip"; readonly reason: string };

/**
 * Decide whether a freshly created worktree may be fast-forwarded to its base's
 * origin ref. This is the post-creation safety net for the creation paths that
 * bypass the before-hook; it must be able to PROVE the reset discards nothing.
 */
export function decideCorrection(input: CorrectDecisionInput): CorrectDecision {
  if (!input.hasMetadata) return { action: "skip", reason: "not a Paseo-owned worktree" };
  if (!input.baseBranch) return { action: "skip", reason: "no base branch recorded" };
  if (!input.hasOriginBase)
    return { action: "skip", reason: `origin/${input.baseBranch} does not exist` };
  if (input.atOriginHead) return { action: "skip", reason: "already at origin head" };
  if (!input.behindOrigin) {
    return {
      action: "skip",
      reason: `worktree has commits origin/${input.baseBranch} does not; leaving it alone`,
    };
  }
  if (input.dirty) {
    return {
      action: "skip",
      reason: `behind origin/${input.baseBranch} but has local changes; leaving it alone`,
    };
  }
  return {
    action: "reset",
    target: `refs/remotes/origin/${input.baseBranch}`,
    reason: `strictly behind origin/${input.baseBranch} with no local changes`,
  };
}
