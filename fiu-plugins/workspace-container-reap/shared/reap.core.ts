/**
 * What a closed workspace means for the containers it started — decided without running anything.
 *
 * The whole decision is here so every branch is assertable without a daemon, a Docker, or a clock:
 * the server half only supplies the archived workspace, the settings and a way to run `fiu`.
 */

export interface ReapSettings {
  /** Master switch. Off means the hook observes and does nothing. */
  readonly enabled: boolean;
  /** Plan only — run the reaper without `--apply` so the log shows what WOULD be stopped. */
  readonly dryRun: boolean;
  /** How long to let Paseo finish tearing the workspace down before asking what is still running. */
  readonly settleMs: number;
  /** Hard cap on one reaper run, so a wedged Docker cannot pin the handler forever. */
  readonly timeoutMs: number;
  /** Absolute path to the `fiu` binary; null means "find it". */
  readonly fiuBin: string | null;
}

export const DEFAULT_SETTINGS: ReapSettings = {
  enabled: true,
  dryRun: false,
  // Paseo's own docs are explicit that "archive events can precede runtime/worktree cleanup", and a
  // work node bound to the workspace is closed on that same teardown. Reaping instantly would race
  // both: the reaper would read a claim that is still live and correctly decline to stop anything.
  settleMs: 20_000,
  timeoutMs: 180_000,
  fiuBin: null,
};

export type ReapDecision =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "run"; readonly workspace: string; readonly argv: readonly string[] };

/** A workspace with no directory never started a stack; there is nothing to scope a reap to. */
export function decide(
  workspace: { readonly cwd: string | null },
  settings: ReapSettings,
): ReapDecision {
  if (!settings.enabled) return { kind: "skip", reason: "disabled by settings" };
  const cwd = workspace.cwd?.trim();
  if (!cwd) return { kind: "skip", reason: "workspace has no directory" };
  return {
    kind: "run",
    workspace: cwd,
    // --workspace is what keeps this safe to fire automatically: it narrows the plan to the stacks
    // defined inside the workspace that just closed, so a sibling's running stack is never a
    // candidate. Without it this would be a global sweep on every archive.
    argv: ["docker", "reap", "--workspace", cwd, ...(settings.dryRun ? [] : ["--apply"])],
  };
}

export type ReapOutcome =
  | { readonly kind: "reaped"; readonly scopes: number; readonly detail: string }
  | { readonly kind: "nothing"; readonly detail: string }
  | { readonly kind: "planned"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const SCOPE_COUNT = /reaped (\d+) scope\(s\)/;
const WOULD_REAP = /would reap (\d+) scope\(s\)/;

/** Strip the reaper's ANSI colouring so the log line reads the same in a file as on a terminal. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Read the reaper's own report rather than re-deriving a verdict from the exit code alone.
 *
 * `fiu docker reap` already verifies its work — it re-lists containers after the compose-down and
 * throws when any remain — so a zero exit means the stop actually happened. What the exit code does
 * NOT say is whether anything was stopped, and that is the only part worth a log line.
 */
export function classify(exitCode: number, output: string, dryRun: boolean): ReapOutcome {
  const text = plain(output).trim();
  const lastLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? "";
  if (exitCode !== 0) return { kind: "failed", detail: lastLine || `exit ${exitCode}` };
  if (dryRun) {
    const planned = WOULD_REAP.exec(text);
    return { kind: "planned", detail: planned ? `would reap ${planned[1]} scope(s)` : lastLine };
  }
  const reaped = SCOPE_COUNT.exec(text);
  if (reaped) return { kind: "reaped", scopes: Number(reaped[1]), detail: lastLine };
  return { kind: "nothing", detail: lastLine || "nothing to reap" };
}
