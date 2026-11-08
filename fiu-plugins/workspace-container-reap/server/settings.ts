import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, type ReapSettings } from "../shared/reap.core";

export const PLUGIN_HOME = path.join(os.homedir(), ".paseo", "workspace-container-reap");
export const SETTINGS_FILE = path.join(PLUGIN_HOME, "settings.json");

export interface SettingsRead {
  readonly settings: ReapSettings;
  /** A malformed file is reported and the DEFAULTS are kept — never a silent half-applied merge. */
  readonly error: string | null;
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFlag(value: unknown): boolean {
  return typeof value === "boolean";
}

function isFiuBin(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

const FIELD_VALIDATORS: Record<
  "enabled" | "dryRun" | "settleMs" | "timeoutMs" | "fiuBin",
  (value: unknown) => boolean
> = {
  enabled: isFlag,
  dryRun: isFlag,
  settleMs: isPositive,
  timeoutMs: isPositive,
  fiuBin: isFiuBin,
};

/** Absent file = defaults, no error: not configuring the plugin is the normal case. */
export function readSettings(file: string = SETTINGS_FILE): SettingsRead {
  if (!existsSync(file)) return { settings: DEFAULT_SETTINGS, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { settings: DEFAULT_SETTINGS, error: `unreadable: ${String(error)}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: DEFAULT_SETTINGS, error: "expected a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const invalidFields = (
    Object.keys(FIELD_VALIDATORS) as Array<keyof typeof FIELD_VALIDATORS>
  ).filter((key) => key in record && !FIELD_VALIDATORS[key](record[key]));
  if (invalidFields.length > 0) {
    return { settings: DEFAULT_SETTINGS, error: `invalid field(s): ${invalidFields.join(", ")}` };
  }
  const fiuBin = typeof record.fiuBin === "string" ? record.fiuBin.trim() : null;
  return {
    settings: {
      enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SETTINGS.enabled,
      dryRun: typeof record.dryRun === "boolean" ? record.dryRun : DEFAULT_SETTINGS.dryRun,
      settleMs: typeof record.settleMs === "number" ? record.settleMs : DEFAULT_SETTINGS.settleMs,
      timeoutMs:
        typeof record.timeoutMs === "number" ? record.timeoutMs : DEFAULT_SETTINGS.timeoutMs,
      fiuBin,
    },
    error: null,
  };
}

/**
 * Find `fiu`, and say so loudly when it is not there.
 *
 * The daemon spawns this plugin with its own environment, which is not a login shell — `~/.local/bin`
 * is on the operator's PATH but not necessarily on the daemon's. Resolving the known install path
 * before falling back to PATH is what stops the hook from failing as a bare ENOENT on a machine where
 * `fiu` is plainly installed. A configured path that does not exist is an error, not a fallback: it
 * means the operator pointed this somewhere and the plugin must not quietly run something else.
 */
export function resolveFiuBin(settings: ReapSettings, home: string = os.homedir()): string {
  if (settings.fiuBin) {
    if (!existsSync(settings.fiuBin)) throw new Error(`fiuBin does not exist: ${settings.fiuBin}`);
    return settings.fiuBin;
  }
  const installed = path.join(home, ".local", "bin", "fiu");
  return existsSync(installed) ? installed : "fiu";
}
