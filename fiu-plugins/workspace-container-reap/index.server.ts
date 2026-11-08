import type { PluginServerContext } from "@getpaseo/plugin/server";

import { classify, decide } from "./shared/reap.core";
import { readSettings, resolveFiuBin, SETTINGS_FILE } from "./server/settings";
import { runFiu } from "./server/run-fiu";

/**
 * workspace-container-reap
 *
 * Stops the containers a workspace started, when that workspace is closed.
 *
 * A Compose stack outlives the worktree that defined it: Paseo archives the workspace, deletes the
 * directory, and the containers keep running — polling, restarting, holding memory — with nothing
 * left that refers to them. They were found running for hours after their worktrees were gone, four
 * of them in crash-restart loops, on a machine that had been paging continuously for two days.
 *
 * The reaping itself is `fiu docker reap`, unchanged: it already knows which projects a live work
 * claim protects and which allowlisted containers are permanent. This plugin only supplies the
 * trigger it never had. `--workspace <cwd>` is what makes that trigger safe to fire automatically —
 * the plan is narrowed to the stacks defined inside the workspace that just closed, so closing one
 * workspace can never stop a stack a sibling is still using.
 *
 * Settings: ~/.paseo/workspace-container-reap/settings.json (see README.md).
 * Logs: `paseo plugin logs workspace-container-reap`.
 */
export default function contribute(server: PluginServerContext) {
  // One reap at a time, process-wide. Closing several workspaces at once must not run concurrent
  // `docker compose down`s against the same engine, and the reaper's read-plan-verify cycle is only
  // coherent if nothing else is removing containers underneath it.
  let queue: Promise<unknown> = Promise.resolve();

  server.on("workspace.archived", (event, { signal }) => {
    const workspace = { cwd: event.workspace.cwd ?? null };
    const name = event.workspace.name ?? event.workspace.id;

    const work = async () => {
      const read = readSettings();
      if (read.error !== null)
        console.error(
          `[workspace-container-reap] ${SETTINGS_FILE}: ${read.error} — using defaults`,
        );
      const settings = read.settings;

      const decision = decide(workspace, settings);
      if (decision.kind === "skip") {
        if (!settings.enabled)
          console.error(`[workspace-container-reap] ${name}: ${decision.reason}`);
        return;
      }

      // Paseo's hook contract says an archive event "can precede runtime/worktree cleanup", and the
      // work node bound to this workspace is released by that same teardown. Reaping immediately
      // would read a claim that is still live and correctly decline to stop anything — so the hook
      // would appear to run and change nothing. Waiting is what makes it actually reap.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settings.settleMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) return;

      let bin: string;
      try {
        bin = resolveFiuBin(settings);
      } catch (error) {
        console.error(
          `[workspace-container-reap] ${name}: cannot run the reaper — ${String(error)}`,
        );
        return;
      }

      const { exitCode, output } = await runFiu(bin, decision.argv, settings.timeoutMs);
      const outcome = classify(exitCode, output, settings.dryRun);
      switch (outcome.kind) {
        case "reaped":
          console.error(
            `[workspace-container-reap] ${name}: stopped ${outcome.scopes} scope(s) from ${decision.workspace}`,
          );
          break;
        case "planned":
          console.error(`[workspace-container-reap] ${name}: dry run — ${outcome.detail}`);
          break;
        case "failed":
          // Loud, and never retried on a timer: a reaper that failed has left containers running,
          // and that is a state the operator should see rather than one the plugin papers over.
          console.error(`[workspace-container-reap] ${name}: reap FAILED — ${outcome.detail}`);
          break;
        default:
          console.error(`[workspace-container-reap] ${name}: nothing to stop`);
          break;
      }
    };

    queue = queue.then(work, work).catch((error: unknown) => {
      console.error(`[workspace-container-reap] handler error on ${name}: ${String(error)}`);
    });
  });

  return () => {};
}
