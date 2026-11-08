/**
 * Daemon half — runs on the HOST, unsandboxed.
 *
 * THE INVARIANT: a Paseo worktree is born with a no-mistakes gate OF ITS OWN, so its first push
 * cannot land on the main checkout's.
 *
 * A gate is keyed on the checkout PATH. Without one, `git push no-mistakes` from a worktree falls
 * through to the container's SHARED `remote.no-mistakes.url` and starts a run on whatever that names
 * — in practice the main checkout's gate. That run is undriveable from the worktree it came from:
 * `no-mistakes axi run` resolves by exact path, finds no repo, and refuses; the stray run then has to
 * be aborted by id before anything can proceed.
 *
 * Measured 2026-09-18 on fiuhq/core: 9 of 16 worktrees were in this state, 5 of them with main's gate
 * written into their own `config.worktree`.
 *
 * WHY HERE AND NOT IN THE RECONCILER. fiu's `reconcileWorktreeGateRemotes` deliberately refuses to
 * enrol — it only records a pushurl for a gate that already exists, because enrolment costs a mirror
 * on disk and a sync should not spend that on every historical worktree it walks (this node carries
 * dozens that will never push again). Creation is where that cost is expected and proportionate: one
 * gate per workspace actually created.
 *
 * The decision itself is pure (`planEnrolment`); this file only gathers its facts and executes it.
 *
 * SAFE BY CONSTRUCTION:
 *  - a checkout that already has its own gate is never re-initialised;
 *  - where the container has a shared url, `no-mistakes init` runs with that `nm://` name mapped onto this
 *    gate for init alone (`initGlobalConfig`: a scratch global config that rewrites it first, then includes
 *    the real global files), because since v1.104 it refuses a shared url it cannot resolve to this
 *    checkout's gate; an older init rewrote the CONTAINER's shared url, so the previous value is still
 *    captured and put back if it moved;
 *  - a failed init puts this worktree's own pushurl back as it was;
 *  - the gate is recorded with `git config --worktree`, never the shared config;
 *  - it verifies the mirror EXISTS after init rather than trusting the exit code;
 *  - every failure logs and returns; workspace creation must never become a hard failure.
 *
 * Deliberately NOT here: reaping a gate when a workspace is archived. Paseo exposes only
 * `workspace.archived` (after the fact, when the directory may already be gone), and a gate mirror can
 * hold the only copy of a parked run's branch — deleting one automatically could destroy work.
 *
 * Logs: `paseo plugin logs workspace-gate-enrol`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  GATE_REMOTE_NAME,
  initGlobalConfig,
  planEnrolment,
  renderPlanLog,
  shouldRestoreSharedUrl,
  type EnrolFacts,
} from "./shared/enrol.core";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;
/** A cold mirror is cloned from origin, so this is minutes, not seconds. */
const INIT_TIMEOUT_MS = 300_000;
const TAG = "[workspace-gate-enrol]";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function gitOrEmpty(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

function nmHome(): string {
  return process.env.NM_HOME || path.join(homedir(), ".no-mistakes");
}

/**
 * The derivation `no-mistakes init` uses for a checkout's gate mirror — the same one fiu-cli's
 * `worktree-gate.ts` pins against live rows (92/93 matched; the exception had been renamed after init).
 */
function gatePathForCheckout(home: string, checkoutPath: string): string {
  const id = createHash("sha256").update(checkoutPath).digest("hex").slice(0, 12);
  return `${home.replace(/\/+$/, "")}/repos/${id}.git`;
}

/**
 * `no-mistakes` is a user-local install, and a daemon's environment does not carry the operator's
 * shell PATH. Resolve it explicitly rather than hoping `PATH` happens to reach it.
 */
function noMistakesBin(): string | null {
  const candidates = [
    process.env.NO_MISTAKES_BIN,
    path.join(homedir(), ".local/bin/no-mistakes"),
    path.join(homedir(), ".no-mistakes/bin/no-mistakes"),
    "/usr/local/bin/no-mistakes",
    "/opt/homebrew/bin/no-mistakes",
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function gatherFacts(cwd: string): Promise<{ facts: EnrolFacts; checkout: string | null }> {
  const checkout = await gitOrEmpty(cwd, ["rev-parse", "--show-toplevel"]);
  const home = nmHome();
  if (!checkout) {
    return {
      checkout: null,
      facts: {
        checkoutPath: null,
        hasOrigin: false,
        derivedGatePath: gatePathForCheckout(home, cwd),
        derivedGateExists: false,
        currentPushurl: null,
        canWriteWorktreeConfig: false,
      },
    };
  }
  const derivedGatePath = gatePathForCheckout(home, checkout);
  return {
    checkout,
    facts: {
      checkoutPath: checkout,
      hasOrigin: Boolean(await gitOrEmpty(checkout, ["config", "--get", "remote.origin.url"])),
      derivedGatePath,
      derivedGateExists: existsSync(derivedGatePath),
      // The MERGED value is what a push actually uses; `--worktree` alone reads null even while a push
      // is silently going to a sibling's gate through the shared config.
      currentPushurl:
        (await gitOrEmpty(checkout, ["config", "--get", `remote.${GATE_REMOTE_NAME}.pushurl`])) ||
        null,
      // `--bool` so git's own spelling set decides: it enables the extension for `1`, `yes`, `on` and
      // `TRUE` alike, and a raw string compare would call such a container unwritable.
      canWriteWorktreeConfig:
        (await gitOrEmpty(checkout, ["config", "--bool", "extensions.worktreeConfig"])) === "true",
    },
  };
}

/** Record the gate in THIS worktree's own config, never the shared one a sibling also reads. */
async function recordPushurl(checkout: string, pushurl: string): Promise<void> {
  await git(checkout, ["config", "--worktree", `remote.${GATE_REMOTE_NAME}.pushurl`, pushurl]);
}

/** Put THIS worktree's own pushurl back as it was (or remove it): a failed enrolment changes nothing. */
async function restorePushurl(checkout: string, previous: string): Promise<void> {
  const key = `remote.${GATE_REMOTE_NAME}.pushurl`;
  await (previous
    ? git(checkout, ["config", "--worktree", key, previous])
    : gitOrEmpty(checkout, ["config", "--worktree", "--unset", key]));
}

/**
 * The files git reads as its global config, in git's own order. GIT_CONFIG_GLOBAL replaces both defaults, so a
 * scratch config has to include them itself; git ignores an include that does not exist.
 */
function realGlobalConfigPaths(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL) return [process.env.GIT_CONFIG_GLOBAL];
  const xdgHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return [path.join(xdgHome, "git", "config"), path.join(homedir(), ".gitconfig")];
}

/**
 * Init starts the shared daemon when it is down, and its detached fallback hands the daemon init's own
 * environment for good. Start it first from the plain environment, and only when it is down: a start on a
 * running daemon refreshes its service and would cut off other checkouts' runs.
 */
async function ensureDaemonPlain(bin: string): Promise<void> {
  // Only a positive "not running" starts it: an unanswered status (a timeout on a loaded node) leaves the
  // daemon alone, and init's own start-if-down still applies.
  const { stdout } = await run(bin, ["daemon", "status"], { timeout: GIT_TIMEOUT_MS }).catch(
    () => ({ stdout: "" }),
  );
  if (/not running/i.test(stdout))
    await run(bin, ["daemon", "start"], { timeout: INIT_TIMEOUT_MS });
}

async function enrol(checkout: string, derivedGatePath: string): Promise<boolean> {
  const bin = noMistakesBin();
  if (!bin) {
    console.error(
      `${TAG} ${checkout}: no-mistakes is not installed on this node — leaving it unenrolled`,
    );
    return false;
  }
  // Captured BEFORE init: an init older than v1.104 rewrites the container's shared url, which every
  // unwired sibling reads.
  const sharedUrlBefore =
    (await gitOrEmpty(checkout, ["config", "--get", `remote.${GATE_REMOTE_NAME}.url`])) || null;
  const globalConfig = initGlobalConfig(derivedGatePath, sharedUrlBefore, realGlobalConfigPaths());
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const previousPushurl = await gitOrEmpty(checkout, [
    "config",
    "--worktree",
    "--get",
    `remote.${GATE_REMOTE_NAME}.pushurl`,
  ]);
  let scratch: string | null = null;
  try {
    if (globalConfig) {
      // Init accepts the shared nm:// url only when it and the push url both resolve to this gate
      // (`initGlobalConfig`). With no shared url there is nothing to resolve, and a pushurl alone would make
      // init's `git remote add` refuse.
      await ensureDaemonPlain(bin);
      await recordPushurl(checkout, derivedGatePath);
      scratch = mkdtempSync(path.join(tmpdir(), "gate-enrol-"));
      env.GIT_CONFIG_GLOBAL = path.join(scratch, "gitconfig");
      writeFileSync(env.GIT_CONFIG_GLOBAL, globalConfig, { mode: 0o600 });
    }
    await run(bin, ["init"], { cwd: checkout, timeout: INIT_TIMEOUT_MS, env });
  } catch (error) {
    await restorePushurl(checkout, previousPushurl);
    throw error;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  // The exit code is a claim; the mirror on disk is the proof.
  if (!existsSync(derivedGatePath)) {
    await restorePushurl(checkout, previousPushurl);
    console.error(`${TAG} ${checkout}: \`no-mistakes init\` left no gate at ${derivedGatePath}`);
    return false;
  }

  const sharedUrlAfter =
    (await gitOrEmpty(checkout, ["config", "--get", `remote.${GATE_REMOTE_NAME}.url`])) || null;
  if (shouldRestoreSharedUrl(sharedUrlBefore, sharedUrlAfter)) {
    await git(checkout, ["config", `remote.${GATE_REMOTE_NAME}.url`, sharedUrlBefore as string]);
    console.error(
      `${TAG} ${checkout}: restored the container's shared gate url to '${sharedUrlBefore}'`,
    );
  }
  return true;
}

/** Exported so the enrolment can be driven directly against a real checkout, not only via the hook. */
export async function enrolWorkspace(cwd: string | null): Promise<void> {
  if (!cwd) return;
  const { facts, checkout } = await gatherFacts(cwd);
  const plan = planEnrolment(facts);
  console.error(`${TAG} ${renderPlanLog(plan, checkout ?? cwd)}`);
  if (plan.action === "ok" || plan.action === "skip") return;

  if (plan.action === "enrol" && !(await enrol(checkout as string, facts.derivedGatePath))) return;
  await recordPushurl(checkout as string, plan.pushurl);
  console.error(`${TAG} ${checkout}: gate ready — pushes from here go to ${plan.pushurl}`);
}

export default function contribute(server: PluginServerContext) {
  server.on("workspace.created", (event) => {
    void enrolWorkspace(event.workspace.cwd ?? null).catch((error: unknown) => {
      // A guard must never turn workspace creation into a hard failure: the worst case is the
      // pre-push gate blocking the first push with the exact repair, which is where we started.
      console.error(`${TAG} enrolment failed, leaving the worktree as it was: ${String(error)}`);
    });
  });

  return () => {};
}
