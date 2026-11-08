import { describe, expect, test } from "bun:test";

import { spawnSync } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initGlobalConfig,
  planEnrolment,
  renderPlanLog,
  sameGate,
  shouldRestoreSharedUrl,
  type EnrolFacts,
} from "./enrol.core";

const NM = "/Users/fiu/.no-mistakes";
const WT = "/Users/fiu/.paseo/worktrees/0rct7wio/stale-lionfish";
const OWN = `${NM}/repos/e7db130a9d9a.git`;
/** The MAIN checkout's gate — the value 5 of 16 fiuhq/core worktrees actually carried. */
const MAINS = `${NM}/repos/464fbd9ad153.git`;

const facts = (over: Partial<EnrolFacts> = {}): EnrolFacts => ({
  checkoutPath: WT,
  hasOrigin: true,
  derivedGatePath: OWN,
  derivedGateExists: false,
  currentPushurl: null,
  canWriteWorktreeConfig: true,
  ...over,
});

describe("sameGate", () => {
  test("a file:// prefix and a trailing slash are the same gate", () => {
    expect(sameGate(`file://${OWN}/`, OWN)).toBe(true);
    expect(sameGate(OWN, `${OWN}/`)).toBe(true);
  });
  test("different gates are different", () => {
    expect(sameGate(MAINS, OWN)).toBe(false);
  });
  test("empty is never equal — an absent pushurl is not a match", () => {
    expect(sameGate(null, OWN)).toBe(false);
    expect(sameGate(null, null)).toBe(false);
    expect(sameGate("", "")).toBe(false);
  });
});

describe("planEnrolment", () => {
  test("a fresh worktree is enrolled", () => {
    expect(planEnrolment(facts())).toEqual({ action: "enrol", pushurl: OWN });
  });

  // The exact live state: main's gate recorded in the worktree's own config.worktree.
  test("a worktree wired to ANOTHER checkout's gate is still enrolled, not left alone", () => {
    expect(planEnrolment(facts({ currentPushurl: MAINS }))).toEqual({
      action: "enrol",
      pushurl: OWN,
    });
  });

  test("an existing gate with a foreign pushurl is REWIRED, never re-initialised", () => {
    expect(planEnrolment(facts({ derivedGateExists: true, currentPushurl: MAINS }))).toEqual({
      action: "rewire",
      pushurl: OWN,
    });
  });

  test("an existing gate already wired to itself costs nothing", () => {
    expect(planEnrolment(facts({ derivedGateExists: true, currentPushurl: OWN }))).toEqual({
      action: "ok",
    });
  });

  test("a gate that exists but is unwired is rewired rather than re-initialised", () => {
    expect(planEnrolment(facts({ derivedGateExists: true, currentPushurl: null }))).toEqual({
      action: "rewire",
      pushurl: OWN,
    });
  });

  test.each([
    ["a path that is not a git checkout", { checkoutPath: null }, "not-a-checkout"],
    ["a checkout without an origin", { hasOrigin: false }, "no-origin"],
    [
      "a container without extensions.worktreeConfig",
      { canWriteWorktreeConfig: false },
      "no-worktree-config",
    ],
  ])("%s is skipped", (_label, over, why) => {
    expect(planEnrolment(facts(over as Partial<EnrolFacts>))).toEqual({
      action: "skip",
      why: why as never,
    });
  });

  test("an already-correct checkout is `ok` even without worktree config — nothing needs writing", () => {
    expect(
      planEnrolment(
        facts({ derivedGateExists: true, currentPushurl: OWN, canWriteWorktreeConfig: false }),
      ),
    ).toEqual({
      action: "ok",
    });
  });
});

describe("shouldRestoreSharedUrl", () => {
  test("init repointing the container's shared url is restored", () => {
    expect(shouldRestoreSharedUrl("nm://projects/fiuhq/core/main", OWN)).toBe(true);
  });
  test("an unchanged shared url is left alone", () => {
    expect(
      shouldRestoreSharedUrl("nm://projects/fiuhq/core/main", "nm://projects/fiuhq/core/main"),
    ).toBe(false);
    expect(shouldRestoreSharedUrl("nm://x", "nm://x/")).toBe(false);
  });
  test("a container that had no shared url gets none invented for it", () => {
    expect(shouldRestoreSharedUrl(null, OWN)).toBe(false);
  });
});

describe("renderPlanLog", () => {
  test("every plan says what happened and why in one line", () => {
    expect(renderPlanLog({ action: "enrol", pushurl: OWN }, WT)).toContain("no-mistakes init");
    expect(renderPlanLog({ action: "rewire", pushurl: OWN }, WT)).toContain("another checkout's");
    expect(renderPlanLog({ action: "ok" }, WT)).toContain("already has its own gate");
    expect(renderPlanLog({ action: "skip", why: "no-origin" }, WT)).toContain("origin");
  });
});

describe("initGlobalConfig: the global git config no-mistakes init reads", () => {
  const SHARED = "nm://projects/fiuhq/core/fix-browser-fullpage-screenshot";
  /** A checkout whose real global config maps the shared name onto MAIN's gate and carries a credential helper. */
  const checkout = () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-enrol-"));
    const real = join(dir, "gitconfig");
    writeFileSync(
      real,
      `[url "${MAINS}"]\n\tinsteadOf = ${SHARED}\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n`,
    );
    const repo = join(dir, "repo");
    const git = (global: string, ...args: string[]) =>
      spawnSync(["git", ...args], {
        cwd: repo,
        env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: global },
      })
        .stdout.toString()
        .trim();
    spawnSync(["git", "init", "-q", repo]);
    git(real, "remote", "add", "no-mistakes", SHARED);
    git(real, "config", "remote.no-mistakes.pushurl", OWN);
    return { git, real, dir };
  };

  test("read as the global config, the shared name's fetch and push urls both resolve to this gate, as init requires, and the real config's helpers stay", () => {
    const { git, real, dir } = checkout();
    expect(git(real, "remote", "get-url", "--all", "no-mistakes")).toBe(MAINS);
    const scratch = join(dir, "init-gitconfig");
    writeFileSync(scratch, initGlobalConfig(OWN, SHARED, [real])!);
    expect(git(scratch, "remote", "get-url", "--all", "no-mistakes")).toBe(OWN);
    expect(git(scratch, "remote", "get-url", "--push", "--all", "no-mistakes")).toBe(OWN);
    expect(git(scratch, "config", "--get", "credential.https://github.com.helper")).toBe(
      "!gh auth git-credential",
    );
    // Nothing was written: under the real config the name still resolves as before.
    expect(git(real, "remote", "get-url", "--all", "no-mistakes")).toBe(MAINS);
  });

  test("a shared url and an include path holding git config's comment characters are read whole", () => {
    const shared = "nm://projects/fiuhq/core/fix-#42;x";
    const dir = mkdtempSync(join(tmpdir(), "gate-enrol-"));
    const real = join(dir, "a#b;c", "gitconfig");
    mkdirSync(join(dir, "a#b;c"));
    writeFileSync(
      real,
      `[url "${MAINS}"]\n\tinsteadOf = "${shared}"\n[credential]\n\thelper = kept\n`,
    );
    const scratch = join(dir, "init-gitconfig");
    writeFileSync(scratch, initGlobalConfig(OWN, shared, [real])!);
    const git = (...args: string[]) =>
      spawnSync(["git", ...args], {
        cwd: join(dir, "repo"),
        env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: scratch },
      })
        .stdout.toString()
        .trim();
    spawnSync(["git", "init", "-q", join(dir, "repo")]);
    git("remote", "add", "no-mistakes", shared);
    expect(git("remote", "get-url", "--all", "no-mistakes")).toBe(OWN);
    expect(git("config", "--get", "credential.helper")).toBe("kept");
  });

  test.each([
    ["no shared remote yet", null],
    ["a shared url that already is this gate", OWN],
  ])("%s: init reads the real global config", (_, shared) => {
    expect(initGlobalConfig(OWN, shared, ["/h/.gitconfig"])).toBeNull();
  });
});
