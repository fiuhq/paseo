import { describe, expect, test } from "bun:test";

import { classify, decide, DEFAULT_SETTINGS, plain, type ReapSettings } from "./reap.core";

const settings = (patch: Partial<ReapSettings> = {}): ReapSettings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
});

describe("decide", () => {
  test("scopes the reaper to the workspace that closed", () => {
    // The load-bearing assertion: --workspace is present and carries THIS workspace's directory.
    // Drop it and the hook becomes a global sweep that stops a sibling's live stack on every close.
    expect(decide({ cwd: "/wt/mine" }, settings())).toEqual({
      kind: "run",
      workspace: "/wt/mine",
      argv: ["docker", "reap", "--workspace", "/wt/mine", "--apply"],
    });
  });

  test("dry run plans without --apply", () => {
    const decision = decide({ cwd: "/wt/mine" }, settings({ dryRun: true }));
    expect(decision).toEqual({
      kind: "run",
      workspace: "/wt/mine",
      argv: ["docker", "reap", "--workspace", "/wt/mine"],
    });
  });

  test("does nothing when disabled", () => {
    expect(decide({ cwd: "/wt/mine" }, settings({ enabled: false }))).toEqual({
      kind: "skip",
      reason: "disabled by settings",
    });
  });

  test.each([[null], [""], ["   "]])("skips a workspace with no directory (%p)", (cwd) => {
    expect(decide({ cwd }, settings())).toEqual({
      kind: "skip",
      reason: "workspace has no directory",
    });
  });
});

describe("classify", () => {
  test("reports how many scopes were actually stopped", () => {
    const output = "  reaped maniacal-starfish\n  reaped 1 scope(s)\n";
    expect(classify(0, output, false)).toEqual({
      kind: "reaped",
      scopes: 1,
      detail: "reaped 1 scope(s)",
    });
  });

  test("a clean run that stopped nothing is not reported as a reap", () => {
    expect(classify(0, "\n  nothing to reap\n", false)).toEqual({
      kind: "nothing",
      detail: "nothing to reap",
    });
  });

  test("a scoped run with no stack of its own is not reported as a reap", () => {
    const output = "  no compose project was started from /wt/mine";
    expect(classify(0, output, false).kind).toBe("nothing");
  });

  test("a dry run reports the plan, never a reap", () => {
    const output = "  would reap 2 scope(s); re-run with --apply";
    expect(classify(0, output, true)).toEqual({ kind: "planned", detail: "would reap 2 scope(s)" });
  });

  test("a non-zero exit is a failure carrying the reaper's own last line", () => {
    const output = "refusing partial reap: compose config unavailable for plain-impala";
    expect(classify(1, output, false)).toEqual({ kind: "failed", detail: output });
  });

  test("reads the real coloured output the reaper prints", () => {
    // The reaper colours its summary; a matcher written against clean text silently stops matching.
    const coloured = "\u001b[32m  reaped 3 scope(s)\u001b[0m";
    expect(classify(0, coloured, false)).toEqual({
      kind: "reaped",
      scopes: 3,
      detail: "reaped 3 scope(s)",
    });
  });

  test("plain strips colour without touching the text", () => {
    expect(plain("\u001b[33m  would reap 1 scope(s)\u001b[0m")).toBe("  would reap 1 scope(s)");
  });
});
