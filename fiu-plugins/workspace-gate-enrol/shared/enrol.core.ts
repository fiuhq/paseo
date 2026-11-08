/**
 * Pure decision logic for gate enrolment. No IO — the caller supplies the facts it gathered from git
 * and the filesystem, so every rule here is unit-testable.
 *
 * THE INVARIANT: a Paseo worktree is born with a no-mistakes gate OF ITS OWN.
 *
 * WHY. A gate is keyed on the checkout PATH: `no-mistakes init` creates
 * `<NM_HOME>/repos/<sha256(path)[:12]>.git` and records the path in its database. A worktree that was
 * never initialised has no such mirror, so `git push no-mistakes` falls through to whatever the
 * container's SHARED `remote.no-mistakes.url` names — the main checkout's gate — and starts a run
 * there. That run cannot be driven from the worktree it came from: `no-mistakes axi run` resolves by
 * exact path, finds no repo, and refuses; the stray run has to be aborted by id.
 *
 * Measured 2026-09-18 on fiuhq/core: of 16 worktrees, 5 carried the MAIN checkout's gate
 * (`464fbd9ad153.git`) in their own `config.worktree` — byte-identical to main's file — and 4 more had
 * no wiring at all. Every push from any of the 9 landed on main's gate.
 *
 * fiu's own reconciler (`reconcileWorktreeGateRemotes`) cannot fix this: it only WRITES a pushurl when
 * the worktree's gate already exists, because enrolment is an act with a cost (a mirror on disk) and
 * it refuses to perform one as a side effect of a sync. Creation time is where that cost is expected,
 * so this is where enrolment belongs — one gate per workspace actually created, none for the dozens of
 * historical worktrees that will never push again.
 *
 * SAFE BY CONSTRUCTION:
 *  - never enrols anything that is not a git checkout with an `origin` (init requires one);
 *  - never enrols a checkout that already has its own gate — that is `ok`, not a re-init;
 *  - a gate that exists but is mis-wired is REWIRED, never re-created;
 *  - it decides only; a failure in the caller leaves the worktree exactly as it was.
 */

/** The gate remote `no-mistakes init` adds to a working repo. */
export const GATE_REMOTE_NAME = "no-mistakes";

export interface EnrolFacts {
  /** Absolute toplevel of the checkout, or null when the path is not a git checkout. */
  readonly checkoutPath: string | null;
  /** `no-mistakes init` refuses without one — it delivers the validated head there. */
  readonly hasOrigin: boolean;
  /** `<NM_HOME>/repos/<derived id>.git` for this checkout. */
  readonly derivedGatePath: string;
  /** Does that mirror exist on this machine? */
  readonly derivedGateExists: boolean;
  /** The checkout's MERGED `remote.no-mistakes.pushurl` (worktree file + shared), or null. */
  readonly currentPushurl: string | null;
  /** `git config --worktree` refuses unless `extensions.worktreeConfig` is on. */
  readonly canWriteWorktreeConfig: boolean;
}

export type EnrolPlan =
  /** Already has its own gate and is wired to it. */
  | { readonly action: "ok" }
  /** Its gate exists; only the pushurl points somewhere else. Cheap — no init. */
  | { readonly action: "rewire"; readonly pushurl: string }
  /** No gate of its own yet: run `no-mistakes init` here, then record the pushurl. */
  | { readonly action: "enrol"; readonly pushurl: string }
  /** Nothing can be done, and why. */
  | {
      readonly action: "skip";
      readonly why: "not-a-checkout" | "no-origin" | "no-worktree-config";
    };

/** Strip a trailing slash so `/x.git` and `/x.git/` are one answer. */
export function trimSlash(p: string): string {
  return (p || "").trim().replace(/\/+$/, "");
}

/** Compare two gate paths ignoring a `file://` prefix and a trailing slash. */
export function sameGate(a: string | null, b: string | null): boolean {
  const l = trimSlash((a ?? "").replace(/^file:\/\//, ""));
  const r = trimSlash((b ?? "").replace(/^file:\/\//, ""));
  return l !== "" && l === r;
}

export function planEnrolment(facts: EnrolFacts): EnrolPlan {
  if (!facts.checkoutPath) return { action: "skip", why: "not-a-checkout" };
  if (!facts.hasOrigin) return { action: "skip", why: "no-origin" };

  // Already correct: its OWN gate exists and the pushurl names it. Nothing to pay for.
  if (facts.derivedGateExists && sameGate(facts.currentPushurl, facts.derivedGatePath)) {
    return { action: "ok" };
  }
  // Recording the pushurl is what makes the wiring survive a sibling's `no-mistakes init` rewriting
  // the SHARED url, so without `--worktree` there is no durable place to put it. Report, never write
  // the shared config — that would hand a sibling THIS checkout's gate.
  if (!facts.canWriteWorktreeConfig) return { action: "skip", why: "no-worktree-config" };

  return facts.derivedGateExists
    ? { action: "rewire", pushurl: facts.derivedGatePath }
    : { action: "enrol", pushurl: facts.derivedGatePath };
}

/**
 * A `no-mistakes init` older than v1.104 writes the SHARED `remote.no-mistakes.url` of the container it
 * runs in, so in a bare+worktrees repo one worktree's enrolment can repoint every sibling that has no
 * pushurl of its own at this worktree's gate. Captured before / compared after, this decides whether to
 * put the container's value back.
 *
 * Observed twice (2026-09-17) on fiuhq/core, where the shared value is the portable
 * `nm://projects/fiuhq/core/main` placeholder that fiu maps to the main checkout's gate.
 */
export function shouldRestoreSharedUrl(before: string | null, after: string | null): boolean {
  if (!before) return false;
  return trimSlash(before) !== trimSlash(after ?? "");
}

export function renderPlanLog(plan: EnrolPlan, checkout: string): string {
  switch (plan.action) {
    case "ok":
      return `${checkout}: already has its own gate`;
    case "rewire":
      return `${checkout}: gate exists but the pushurl named another checkout's — rewiring to ${plan.pushurl}`;
    case "enrol":
      return `${checkout}: no gate of its own — running \`no-mistakes init\` so its pushes do not land on another checkout's gate`;
    case "skip":
      return `${checkout}: left alone (${
        plan.why === "not-a-checkout"
          ? "not a git checkout"
          : plan.why === "no-origin"
            ? "no 'origin' remote, which `no-mistakes init` requires"
            : "extensions.worktreeConfig is not enabled, so there is no per-worktree place to record the gate"
      })`;
  }
}

/** A git config value or subsection name, read whole even with a `#` or `;` in it. */
function configQuoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The global git config `no-mistakes init` reads, or null when the real one will do. Since v1.104
 * (no-mistakes #1625) init never rewrites a remote whose literal url sits outside its repos dir, and accepts
 * one only when every fetch and push url resolves to this checkout's gate. A container's shared url is an
 * `nm://` name that the operator's global config maps onto some other gate, and git keeps the FIRST of
 * equally long `insteadOf` matches, so a rewrite added later (per-worktree, or on the command line) loses.
 * This file puts the rewrite onto this gate first and then includes the real global files, given in git's own
 * read order, so init keeps every credential helper and setting while the shared name resolves to this gate.
 * No shared config is written. The push url must already name the gate.
 */
export function initGlobalConfig(
  gatePath: string,
  sharedUrl: string | null,
  realGlobalPaths: readonly string[],
): string | null {
  if (!sharedUrl || sameGate(sharedUrl, gatePath)) return null;
  const includes = realGlobalPaths.map((p) => `\tpath = ${configQuoted(p)}\n`).join("");
  return `[url ${configQuoted(gatePath)}]\n\tinsteadOf = ${configQuoted(sharedUrl)}\n[include]\n${includes}`;
}
