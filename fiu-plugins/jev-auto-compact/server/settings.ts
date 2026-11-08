/**
 * Settings live in one JSON file the operator edits, re-read whenever it changes.
 *
 * Paseo's `registerSettings` stores values host-side for the UI to write, but exposes no
 * server-side read, so a file is what a daemon plugin can actually consult — and it is
 * editable without a daemon restart, which a compaction policy needs while it is being
 * tuned. A file that does not parse disables the plugin and says why: with judgment this
 * consequential, an unreadable policy must never silently become the default one.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_POLICY, type CompactPolicy } from "../shared/compaction.core";

export interface CompactSettings {
  readonly enabled: boolean;
  readonly policy: CompactPolicy;
  /**
   * Agent ids this plugin may act on; empty means every agent. A scope for rolling it
   * out — or for trying it on one session — without disabling it everywhere.
   */
  readonly agents: readonly string[];
  readonly jevBin: string;
  readonly jevTimeoutMs: number;
  /** Log every outcome, including the skips a quiet daemon should not print. */
  readonly debug: boolean;
}

export const PASEO_HOME = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
export const PLUGIN_HOME = path.join(PASEO_HOME, "jev-auto-compact");
export const SETTINGS_FILE = path.join(PLUGIN_HOME, "settings.json");
/** Everything this plugin wrote under its pre-rename id: a node that ran it has a whole home here, not just a settings file. */
export const LEGACY_PLUGIN_HOME = path.join(PASEO_HOME, "fiu-compact");
/** Where this plugin's settings lived under its pre-rename id — moved here once, so a node's existing policy survives the rename. */
export const LEGACY_SETTINGS_FILE = path.join(LEGACY_PLUGIN_HOME, "settings.json");

export const DEFAULT_SETTINGS: CompactSettings = {
  enabled: true,
  policy: DEFAULT_POLICY,
  agents: [],
  jevBin: path.join(os.homedir(), ".local", "bin", "fiu"),
  jevTimeoutMs: 45_000,
  debug: false,
};

export type SettingsRead =
  | { readonly settings: CompactSettings; readonly error: null; readonly changed: boolean }
  | { readonly settings: null; readonly error: string; readonly changed: boolean };

type Problems = string[];

function bool(raw: unknown, at: string, fallback: boolean, problems: Problems): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    problems.push(`${at} must be true or false`);
    return fallback;
  }
  return raw;
}

function num(
  raw: unknown,
  at: string,
  fallback: number,
  problems: Problems,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push(`${at} must be a number`);
    return fallback;
  }
  if (raw < min || raw > max) {
    problems.push(`${at} must be between ${min} and ${max}`);
    return fallback;
  }
  return raw;
}

function str(raw: unknown, at: string, fallback: string, problems: Problems): string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim() === "") {
    problems.push(`${at} must be a non-empty string`);
    return fallback;
  }
  return raw;
}

function strings(
  raw: unknown,
  at: string,
  fallback: readonly string[],
  problems: Problems,
): readonly string[] {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    problems.push(`${at} must be an array of strings`);
    return fallback;
  }
  return raw as string[];
}

export function parseSettings(raw: unknown): SettingsRead {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: null, error: "settings must be a JSON object", changed: true };
  }
  const input = raw as Record<string, unknown>;
  const problems: Problems = [];
  if (
    input.policy !== undefined &&
    (typeof input.policy !== "object" || input.policy === null || Array.isArray(input.policy))
  ) {
    problems.push("policy must be an object");
  }
  const policyInput = (
    typeof input.policy === "object" && input.policy !== null && !Array.isArray(input.policy)
      ? input.policy
      : {}
  ) as Record<string, unknown>;

  const settings: CompactSettings = {
    enabled: bool(input.enabled, "enabled", DEFAULT_SETTINGS.enabled, problems),
    policy: {
      floor: num(policyInput.floor, "policy.floor", DEFAULT_POLICY.floor, problems, 0, 1),
      minTokens: num(
        policyInput.minTokens,
        "policy.minTokens",
        DEFAULT_POLICY.minTokens,
        problems,
        0,
        10_000_000,
      ),
      minUsedRatio: num(
        policyInput.minUsedRatio,
        "policy.minUsedRatio",
        DEFAULT_POLICY.minUsedRatio,
        problems,
        0,
        1,
      ),
      redactWords: strings(
        policyInput.redactWords,
        "policy.redactWords",
        DEFAULT_POLICY.redactWords,
        problems,
      ),
      dryRun: bool(policyInput.dryRun, "policy.dryRun", DEFAULT_POLICY.dryRun, problems),
    },
    agents: strings(input.agents, "agents", DEFAULT_SETTINGS.agents, problems),
    jevBin: str(input.jevBin, "jevBin", DEFAULT_SETTINGS.jevBin, problems),
    jevTimeoutMs: num(
      input.jevTimeoutMs,
      "jevTimeoutMs",
      DEFAULT_SETTINGS.jevTimeoutMs,
      problems,
      1_000,
      300_000,
    ),
    debug: bool(input.debug, "debug", DEFAULT_SETTINGS.debug, problems),
  };

  if (problems.length > 0) return { settings: null, error: problems.join("; "), changed: true };
  return { settings, error: null, changed: true };
}

/** Reads the file at most once per change, so a per-turn read costs one `stat`. */
export class SettingsFile {
  private stamp: string | null = null;
  private migrated = false;
  private last: SettingsRead = { settings: DEFAULT_SETTINGS, error: null, changed: true };

  constructor(
    private readonly file: string = SETTINGS_FILE,
    private readonly legacyFile: string = LEGACY_SETTINGS_FILE,
  ) {}

  async read(): Promise<SettingsRead> {
    const migration = await this.migrate();
    if (migration !== null) {
      this.stamp = null;
      this.last = { settings: null, error: migration, changed: true };
      return this.last;
    }

    let stamp = "missing";
    try {
      const stat = await fs.stat(this.file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (error: unknown) {
      // ENOENT is the ordinary case: no file means the defaults are the policy until someone
      // edits one. Anything else (a broken directory component, a permission change) is NOT a
      // missing file, and reading it as one would quietly restore enabled defaults over the
      // scope and redaction the operator configured. That is the one mistake this adapter
      // exists to refuse, so it disables instead, and re-reads on the next turn rather than
      // caching the failure as a state.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.stamp = null;
        this.last = {
          settings: null,
          error: `cannot read settings: ${String(error)}`,
          changed: true,
        };
        return this.last;
      }
    }
    if (stamp === this.stamp) return { ...this.last, changed: false } as SettingsRead;

    this.stamp = stamp;
    if (stamp === "missing") {
      this.last = { settings: DEFAULT_SETTINGS, error: null, changed: true };
      return this.last;
    }

    try {
      this.last = parseSettings(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error: unknown) {
      this.stamp = null;
      this.last = {
        settings: null,
        error: `cannot read settings: ${String(error)}`,
        changed: true,
      };
    }
    return this.last;
  }

  /**
   * Carry a node's policy across the rename — ONCE, by copying the file to the current name rather
   * than reading two places forever. A second READ path would keep the live policy authoritative at
   * the old name: an edit there would be read through a stamp that never changes, and an edit at the
   * new name would silently win over it. This plugin always reads only its own current-name file
   * after this runs once.
   *
   * The source is copied, not renamed: `fiu ws` removes the pre-rename id's row only after this
   * plugin is installed and holding its disabled choice, but that removal is a separate daemon action
   * that can still be pending or failing while this runs. Deleting the source here would blank a
   * still-running pre-rename instance's policy out from under it — the same silent "enabled defaults
   * over a disabled plugin" this adapter exists to refuse, just moved to the OTHER copy. Leaving the
   * source in place costs one orphaned file once the old id is actually retired; it never costs the
   * operator's policy.
   *
   * Only the policy moves. It is the operator's, and losing it would silently restore enabled
   * defaults over a disabled plugin, an agent allowlist, or the words this fleet redacts before a
   * turn is described to the judge. The ledger beside it is derived state that rebuilds itself from
   * the next turn, so it is left where it is.
   *
   * Returns null when there is nothing to do or the copy succeeded, and the reason when it failed.
   * A failure is NOT remembered as done: the next turn tries again and keeps reporting, because the
   * one outcome this must never produce is a node quietly running on defaults with the operator's
   * policy still sitting under the old name.
   */
  private async migrate(): Promise<string | null> {
    if (this.migrated) return null;
    const settled = (): null => {
      this.migrated = true;
      return null;
    };
    try {
      await fs.stat(this.file);
      return settled(); // Already settled under the current name.
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return settled(); // The read path reports it.
    }
    try {
      await fs.stat(this.legacyFile);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return settled(); // Nothing was ever configured.
      return `cannot read the pre-rename settings ${this.legacyFile}: ${String(error)}`;
    }
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.copyFile(this.legacyFile, this.file, fs.constants.COPYFILE_EXCL);
      console.error(`[jev-auto-compact] copied settings from ${this.legacyFile} to ${this.file}`);
      return settled();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return settled(); // Raced with another copy.
      return `cannot copy the pre-rename settings ${this.legacyFile} to ${this.file}: ${String(error)}`;
    }
  }
}
