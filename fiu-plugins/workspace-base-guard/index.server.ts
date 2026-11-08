/**
 * Daemon half — runs on the HOST, unsandboxed.
 *
 * THE INVARIANT: a worktree Paseo creates starts from the RECENT REMOTE HEAD,
 * never from a stale local branch.
 *
 * Paseo resolves a bare branch name LOCAL-FIRST (`refs/heads/<name>` before
 * `refs/remotes/origin/<name>`). Its docs say "Use `origin/main` rather than `main`",
 * and a live probe on 2026-09-17 confirmed a bare `release/V3` produced a worktree
 * 24 commits behind `origin/release/V3`. A request with NO base at all is worse:
 * `resolveDefaultBranch` prefers the local name whenever that branch exists.
 *
 * TWO LAYERS, because Paseo has two worktree-creation code paths:
 *
 *  1. `workspace.create` BEFORE-hook — rewrites the request before Paseo resolves
 *     it. Covers the message path: the UI New-workspace dialog and
 *     `paseo workspace create`. Requests are corrected with no work to undo.
 *
 *  2. `workspace.created` safety net — the MCP `create_workspace` tool and the
 *     `create_agent` worktree target call `createPaseoWorktreeCommand` directly and
 *     never pass through the message handler, so no before-hook runs for them
 *     (measured: no hook log and a stale base on 2026-09-17). After creation this
 *     layer fast-forwards such a worktree to its recorded base's origin ref —
 *     but ONLY when that provably discards nothing.
 *
 * SAFE BY CONSTRUCTION:
 *  - branch-off only for layer 1; a checkout / change request names its own ref.
 *  - a branch with unpushed local commits is kept, never swapped for origin.
 *  - layer 2 acts only on a clean worktree strictly behind origin; a dirty or
 *    diverged worktree is reported, never reset.
 *  - any failure leaves things untouched and logs — a guard must never turn
 *    workspace creation into a hard failure.
 *
 * Logs: `paseo plugin logs workspace-base-guard`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  candidateBranches,
  decideCorrection,
  rewriteBaseRefs,
  shouldGuard,
  type BranchFacts,
} from "./shared/base.core";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;
const TAG = "[workspace-base-guard]";

type Paseo = Parameters<Parameters<PluginServerContext["before"]>[1]>[1]["paseo"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function remoteNames(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, ["remote"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function branchFacts(cwd: string, branch: string): Promise<BranchFacts> {
  const [hasOrigin, hasLocal] = await Promise.all([
    gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]),
    gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
  ]);
  let ahead: number | null = null;
  if (hasOrigin && hasLocal) {
    try {
      const stdout = await git(cwd, [
        "rev-list",
        "--count",
        `refs/remotes/origin/${branch}..refs/heads/${branch}`,
      ]);
      const parsed = Number.parseInt(stdout.trim(), 10);
      ahead = Number.isNaN(parsed) ? null : parsed;
    } catch {
      ahead = null;
    }
  }
  return { hasOrigin, hasLocal, ahead };
}

async function resolveProjectRoot(
  projectId: string | undefined,
  paseo: Paseo,
): Promise<string | null> {
  if (!projectId) return null;
  try {
    const listed = await paseo.projects.list();
    return (
      listed.projects.find((project) => project.projectId === projectId)?.projectRootPath ?? null
    );
  } catch {
    return null;
  }
}

export default function contribute(server: PluginServerContext) {
  server.before("workspace.create", async ({ request }, { paseo }) => {
    try {
      const source = request.source;
      if (source.kind !== "worktree") return request;
      if (
        !shouldGuard({
          action: source.action,
          refName: source.refName,
          baseBranch: source.baseBranch,
          hasCheckoutSource:
            source.checkoutSource !== undefined || source.githubPrNumber !== undefined,
        })
      ) {
        return request;
      }

      const cwd = source.cwd ?? (await resolveProjectRoot(source.projectId, paseo));
      if (!cwd) {
        console.error(`${TAG} no cwd and no project root; leaving the request untouched`);
        return request;
      }

      const remotes = await remoteNames(cwd);
      const bases = candidateBranches(
        { refName: source.refName, baseBranch: source.baseBranch },
        remotes,
      );
      if (bases.length === 0) return request;

      const facts = new Map(
        await Promise.all(
          bases.map(async (branch) => [branch, await branchFacts(cwd, branch)] as const),
        ),
      );
      const result = rewriteBaseRefs(
        { refName: source.refName, baseBranch: source.baseBranch },
        { remoteNames: remotes, branches: facts },
      );

      if (result.rewrites.length === 0) {
        for (const kept of result.kept)
          console.error(`${TAG} kept ${kept.field} '${kept.from}': ${kept.reason}`);
        return request;
      }
      for (const rewrite of result.rewrites) {
        console.error(
          `${TAG} ${rewrite.field} '${rewrite.from}' -> '${rewrite.to}' so the worktree starts from remote head`,
        );
      }
      return {
        ...request,
        source: {
          ...source,
          ...(result.refName !== undefined ? { refName: result.refName } : {}),
          ...(result.baseBranch !== undefined ? { baseBranch: result.baseBranch } : {}),
        },
      };
    } catch (error: unknown) {
      console.error(`${TAG} left the request untouched: ${String(error)}`);
      return request;
    }
  });

  server.on("workspace.created", (event) => {
    void correctStaleWorktree(event.workspace.cwd).catch((error: unknown) => {
      console.error(`${TAG} post-create check failed: ${String(error)}`);
    });
  });

  return () => {};
}

function branchNameOf(ref: string | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
}

/**
 * Fast-forward a freshly created Paseo worktree to its recorded base's origin ref.
 *
 * Reached only by the creation paths that bypass the before-hook. The decision itself
 * is pure (`decideCorrection`); this function only gathers its facts from git.
 */
async function correctStaleWorktree(cwd: string | null): Promise<void> {
  if (!cwd) return;
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!root) return;

  const gitDir = (await git(root, ["rev-parse", "--git-dir"]).catch(() => "")).trim();
  if (!gitDir) return;
  const metadataPath = path.resolve(root, gitDir, "paseo", "worktree.json");
  if (!existsSync(metadataPath)) return;

  let baseBranch: string | null = null;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      baseRef?: string;
      baseRefName?: string;
    };
    baseBranch = branchNameOf(metadata.baseRef ?? metadata.baseRefName);
  } catch (error: unknown) {
    console.error(`${TAG} unreadable worktree metadata at ${metadataPath}: ${String(error)}`);
    return;
  }
  if (!baseBranch) return;

  const originRef = `refs/remotes/origin/${baseBranch}`;
  const hasOriginBase = await gitOk(root, ["show-ref", "--verify", "--quiet", originRef]);
  const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const originHead = hasOriginBase
    ? (await git(root, ["rev-parse", originRef]).catch(() => "")).trim()
    : "";
  const behindOrigin =
    hasOriginBase && head.length > 0 && head !== originHead
      ? await gitOk(root, ["merge-base", "--is-ancestor", "HEAD", originRef])
      : false;
  const dirty =
    behindOrigin &&
    (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim().length > 0;

  const decision = decideCorrection({
    hasMetadata: true,
    baseBranch,
    hasOriginBase,
    atOriginHead: head.length > 0 && head === originHead,
    behindOrigin,
    dirty,
  });

  if (decision.action === "skip") {
    console.error(`${TAG} worktree ${root}: ${decision.reason}`);
    return;
  }

  await git(root, ["reset", "--hard", decision.target]);
  console.error(
    `${TAG} fast-forwarded worktree ${root} to origin/${baseBranch} (${head.slice(0, 8)} -> ${originHead.slice(0, 8)})`,
  );
}
