import type { UsageReportEntry } from "./types";

/** The order ZeroSub names its providers in, which the Usage dialog groups its accounts by. */
const PROVIDER_ORDER = ["claude", "codex", "kimi", "copilot", "opencode"];

export interface UsageAccountGroup {
  provider: string;
  label: string;
  entries: UsageReportEntry[];
}

/**
 * The Usage dialog's layout when its reports are accounts (ZeroSub's): one group per provider,
 * in ZeroSub's provider order, each holding its signed-in accounts in the feed's order; the
 * signed-out accounts apart, for the one line that names them. Null when the reports are the
 * daemon's, which keep today's flat list.
 */
export function usageAccountGroups(
  reports: readonly UsageReportEntry[],
): { groups: UsageAccountGroup[]; signedOut: UsageReportEntry[] } | null {
  if (reports.length === 0 || !reports.every((entry) => entry.presentation)) return null;
  const groups = new Map<string, UsageAccountGroup>();
  const signedOut: UsageReportEntry[] = [];
  for (const entry of reports) {
    const presentation = entry.presentation!;
    if (presentation.signedOut) {
      signedOut.push(entry);
      continue;
    }
    const group = groups.get(presentation.provider);
    if (group) group.entries.push(entry);
    else
      groups.set(presentation.provider, {
        provider: presentation.provider,
        label: entry.sourceLabel,
        entries: [entry],
      });
  }
  const rank = (provider: string) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
  };
  return {
    groups: [...groups.values()].sort((a, b) => rank(a.provider) - rank(b.provider)),
    signedOut,
  };
}

/**
 * The signed-out accounts' names on their shared line: each by its provider, and by provider and
 * its own name where several of them share a provider.
 */
export function signedOutNames(entries: readonly UsageReportEntry[]): string[] {
  const providers = entries.map((entry) => entry.presentation!.provider);
  return entries.map((entry, index) => {
    const provider = providers[index]!;
    return providers.indexOf(provider) === providers.lastIndexOf(provider)
      ? entry.sourceLabel
      : `${entry.sourceLabel} (${entry.presentation!.name})`;
  });
}

/**
 * An account whose usage cannot be read and never was (OpenCode Go reads only in its console):
 * a fact about the account, told in a muted note without an Error pill. A re-read that failed
 * behind a retained reading stays an error.
 */
export function isAccountNote(entry: UsageReportEntry): boolean {
  return entry.presentation != null && entry.report.status === "error" && !entry.lastSuccessful;
}

/** When the accounts were last read: the newest successful reading among them. */
export function lastReadAt(reports: readonly UsageReportEntry[]): string | null {
  return reports.reduce<string | null>((newest, entry) => {
    const at = entry.successfulAt ?? null;
    return at && (!newest || at > newest) ? at : newest;
  }, null);
}
