import { describe, expect, test } from "bun:test";
import {
  candidateBranches,
  decideCorrection,
  planBaseRef,
  rewriteBaseRefs,
  shouldGuard,
  type BaseRefFacts,
} from "./base.core";

const facts = (
  branches: Record<string, { hasOrigin: boolean; hasLocal?: boolean; ahead?: number | null }>,
  remotes: string[] = ["origin"],
): BaseRefFacts => ({
  remoteNames: remotes,
  branches: new Map(
    Object.entries(branches).map(([name, b]) => [
      name,
      { hasOrigin: b.hasOrigin, hasLocal: b.hasLocal ?? true, ahead: b.ahead ?? 0 },
    ]),
  ),
});

describe("planBaseRef", () => {
  test("qualifies a bare branch that origin also has", () => {
    expect(planBaseRef("release/V3", facts({ "release/V3": { hasOrigin: true } }))).toEqual({
      action: "qualify",
      from: "release/V3",
      to: "origin/release/V3",
      reason: "local branch is not ahead of origin",
    });
  });

  test("qualifies a branch only origin has", () => {
    const plan = planBaseRef(
      "release/V3",
      facts({ "release/V3": { hasOrigin: true, hasLocal: false } }),
    );
    expect(plan.action).toBe("qualify");
    if (plan.action === "qualify") expect(plan.reason).toBe("only origin has this branch");
  });

  test("NEVER discards unpushed local commits", () => {
    const plan = planBaseRef("release/V3", facts({ "release/V3": { hasOrigin: true, ahead: 3 } }));
    expect(plan.action).toBe("keep");
    if (plan.action === "keep") expect(plan.reason).toContain("3 unpushed");
  });

  test("keeps an origin-qualified ref untouched", () => {
    const plan = planBaseRef("origin/release/V3", facts({ "release/V3": { hasOrigin: true } }));
    expect(plan.action).toBe("keep");
  });

  test("keeps an exact refs/ path untouched", () => {
    expect(
      planBaseRef("refs/remotes/origin/main", facts({ main: { hasOrigin: true } })).action,
    ).toBe("keep");
  });

  test("keeps a differently-named remote without double-qualifying", () => {
    const plan = planBaseRef(
      "upstream/main",
      facts({ main: { hasOrigin: true } }, ["origin", "upstream"]),
    );
    expect(plan.action).toBe("keep");
  });

  test("keeps a local-only branch so it stays reachable", () => {
    const plan = planBaseRef("feature/local", facts({ "feature/local": { hasOrigin: false } }));
    expect(plan.action).toBe("keep");
    if (plan.action === "keep") expect(plan.reason).toContain("no origin counterpart");
  });

  test("leaves the request alone when facts are unavailable", () => {
    const plan = planBaseRef("release/V3", facts({}));
    expect(plan.action).toBe("keep");
    if (plan.action === "keep") expect(plan.reason).toContain("facts unavailable");
  });

  test("reports absent for empty and whitespace input", () => {
    expect(planBaseRef("", facts({})).action).toBe("absent");
    expect(planBaseRef("   ", facts({})).action).toBe("absent");
    expect(planBaseRef(undefined, facts({})).action).toBe("absent");
  });
});

describe("shouldGuard", () => {
  test("guards a plain branch-off", () => {
    expect(shouldGuard({ action: "branch-off" })).toBe(true);
    expect(shouldGuard({})).toBe(true);
  });

  test("never touches a checkout request", () => {
    expect(shouldGuard({ action: "checkout" })).toBe(false);
  });

  test("never touches a change-request checkout", () => {
    expect(shouldGuard({ action: "branch-off", hasCheckoutSource: true })).toBe(false);
  });
});

describe("candidateBranches", () => {
  test("collects a bare branch that contains slashes, de-duplicated", () => {
    expect(candidateBranches({ refName: "release/V3", baseBranch: "release/V3" })).toEqual([
      "release/V3",
    ]);
  });

  test("skips exact refs and remote-qualified names", () => {
    expect(candidateBranches({ refName: "origin/main", baseBranch: "refs/heads/dev" })).toEqual([]);
    expect(candidateBranches({ baseBranch: "upstream/main" }, ["origin", "upstream"])).toEqual([]);
  });

  test("handles missing and empty fields", () => {
    expect(candidateBranches({})).toEqual([]);
    expect(candidateBranches({ baseBranch: "  " })).toEqual([]);
    expect(candidateBranches({ baseBranch: "main" })).toEqual(["main"]);
  });
});

describe("rewriteBaseRefs", () => {
  test("rewrites both fields when both carry a bare name", () => {
    const out = rewriteBaseRefs(
      { refName: "release/V3", baseBranch: "release/V3" },
      facts({ "release/V3": { hasOrigin: true } }),
    );
    expect(out.refName).toBe("origin/release/V3");
    expect(out.baseBranch).toBe("origin/release/V3");
    expect(out.rewrites.map((r) => r.field).sort()).toEqual(["baseBranch", "refName"]);
  });

  test("leaves fields the caller did not set unset", () => {
    const out = rewriteBaseRefs({ baseBranch: "main" }, facts({ main: { hasOrigin: true } }));
    expect(out.baseBranch).toBe("origin/main");
    expect("refName" in out).toBe(false);
  });

  test("preserves a local-only branch unchanged", () => {
    const out = rewriteBaseRefs(
      { baseBranch: "wip/scratch" },
      facts({ "wip/scratch": { hasOrigin: false } }),
    );
    expect(out.baseBranch).toBe("wip/scratch");
    expect(out.rewrites).toEqual([]);
    expect(out.kept[0]?.field).toBe("baseBranch");
  });

  test("does not report a rewrite when the local branch is ahead", () => {
    const out = rewriteBaseRefs(
      { baseBranch: "release/V3" },
      facts({ "release/V3": { hasOrigin: true, ahead: 1 } }),
    );
    expect(out.baseBranch).toBe("release/V3");
    expect(out.rewrites).toEqual([]);
  });
});
describe("decideCorrection", () => {
  const base = {
    hasMetadata: true,
    baseBranch: "release/V3",
    hasOriginBase: true,
    atOriginHead: false,
    behindOrigin: true,
    dirty: false,
  };

  test("resets a clean worktree strictly behind origin", () => {
    const d = decideCorrection(base);
    expect(d.action).toBe("reset");
    if (d.action === "reset") expect(d.target).toBe("refs/remotes/origin/release/V3");
  });

  test("skips a worktree that is not Paseo-owned", () => {
    expect(decideCorrection({ ...base, hasMetadata: false }).action).toBe("skip");
  });

  test("skips when no base branch is recorded", () => {
    expect(decideCorrection({ ...base, baseBranch: null }).action).toBe("skip");
  });

  test("skips when origin lacks the base", () => {
    expect(decideCorrection({ ...base, hasOriginBase: false }).action).toBe("skip");
  });

  test("skips an already-current worktree", () => {
    expect(decideCorrection({ ...base, atOriginHead: true }).action).toBe("skip");
  });

  test("NEVER resets a worktree with commits origin does not have", () => {
    const d = decideCorrection({ ...base, behindOrigin: false });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toContain("does not");
  });

  test("NEVER resets a dirty worktree", () => {
    const d = decideCorrection({ ...base, dirty: true });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toContain("local changes");
  });
});
