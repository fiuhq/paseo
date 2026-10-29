import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatDurationUntil } from "./format";
import { UsageMeter } from "./meter";
import { usedPercent } from "./model";
import { useUsageHostReports } from "./queries";
import { UsageProviderIcon } from "./source-icon";
import { windowTone } from "./tone";
import type { UsageReportEntry, UsageWindow } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

// The composer popover's other accounts, under the agent's own: every account ZeroSub holds
// besides it, one line each, with the window closest to its limit. The fork's own file;
// upstream's agent-usage.tsx hands over to it.

/** A window's share of its limit, or none when it reports no share. */
function shareOf(window: UsageWindow): number {
  return usedPercent(window) ?? 0;
}

/** The window that stops the account soonest: its fullest, a model-scoped window aside. */
export function fullestWindow(entry: UsageReportEntry): UsageWindow | null {
  const report = entry.report.status === "available" ? entry.report : entry.lastSuccessful?.report;
  const windows = (report?.windows ?? []).filter((window) => !window.label.includes(" · "));
  return windows.reduce<UsageWindow | null>(
    (fullest, window) => (!fullest || shareOf(window) > shareOf(fullest) ? window : fullest),
    null,
  );
}

/**
 * The agent's own account as the popover shows it: its main windows (a model-scoped one aside),
 * its agents in the footer rather than an In use badge, and no read time beside Refresh.
 */
export function asAgentAccount(entry: UsageReportEntry): UsageReportEntry {
  if (!entry.presentation) return entry;
  const presentation = { ...entry.presentation, inUse: false, omitReadTime: true };
  if (entry.report.status !== "available") return { ...entry, presentation };
  const windows = entry.report.windows.filter((window) => !window.label.includes(" · "));
  return { ...entry, presentation, report: { ...entry.report, windows } };
}

/** The accounts the popover lists under the agent's own: signed in, and not the agent's. */
export function otherAccounts(
  reports: readonly UsageReportEntry[],
  agentReports: readonly UsageReportEntry[],
): UsageReportEntry[] {
  const own = new Set(agentReports.map((entry) => entry.id));
  return reports.filter(
    (entry) => entry.presentation && !entry.presentation.signedOut && !own.has(entry.id),
  );
}

export function OtherAccounts({
  serverId,
  agentReports,
}: {
  serverId: string;
  agentReports: readonly UsageReportEntry[];
}) {
  const { t } = useTranslation();
  const reports = useUsageHostReports(serverId);
  // Only beside an account of ZeroSub's: the daemon's reports have no other accounts to list.
  if (!agentReports.some((entry) => entry.presentation)) return null;
  const others = otherAccounts(reports, agentReports);
  if (others.length === 0) return null;
  return (
    <View style={styles.section} testID="usage-other-accounts">
      <Text style={styles.heading}>{t("providerUsage.zeroSub.otherAccounts")}</Text>
      {others.map((entry, index) => (
        <OtherAccount key={entry.id} serverId={serverId} entry={entry} first={index === 0} />
      ))}
    </View>
  );
}

/** What an account's line says under its name: when it comes back, else its plan and agents. */
function useAccountState(entry: UsageReportEntry): { text: string; limited: boolean } {
  const { t } = useTranslation();
  const presentation = entry.presentation!;
  const now = useRelativeTimeTick({ enabled: presentation.limitedUntil != null });
  if (presentation.limitedUntil) {
    const back = formatDurationUntil(presentation.limitedUntil, now, t);
    const text = back
      ? t("providerUsage.zeroSub.limited", { duration: back })
      : t("providerUsage.zeroSub.limitedNow");
    return { text, limited: true };
  }
  const plan = entry.report.status === "available" ? entry.report.planLabel : undefined;
  const agents =
    presentation.agents > 0
      ? t("providerUsage.zeroSub.agents", { count: presentation.agents })
      : undefined;
  return { text: [plan, agents].filter(Boolean).join(" · "), limited: false };
}

function OtherAccount({
  serverId,
  entry,
  first,
}: {
  serverId: string;
  entry: UsageReportEntry;
  first: boolean;
}) {
  const { t } = useTranslation();
  const presentation = entry.presentation!;
  const state = useAccountState(entry);
  const window = fullestWindow(entry);
  return (
    <View
      style={[styles.row, first ? null : styles.rowRule]}
      testID={`usage-other-account-${entry.id}`}
    >
      <UsageProviderIcon provider={presentation.provider} serverId={serverId} size={14} />
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>
          {presentation.name}
        </Text>
        {state.text ? (
          <Text style={state.limited ? styles.limited : styles.state} numberOfLines={1}>
            {state.text}
          </Text>
        ) : null}
      </View>
      {window ? (
        <View style={styles.window}>
          <View style={styles.windowText}>
            <Text style={styles.windowLabel}>{window.shortLabel ?? window.label}</Text>
            <Text style={styles.windowValue}>{`${Math.round(shareOf(window))}%`}</Text>
          </View>
          <UsageMeter percent={shareOf(window)} tone={windowTone(window)} />
        </View>
      ) : (
        // An account whose usage its provider shows only in its own console.
        <Text style={styles.state}>{t("providerUsage.zeroSub.consoleOnly")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[1],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rowRule: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  who: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  state: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  limited: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  window: {
    width: 92,
    gap: 3,
  },
  windowText: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  windowLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  windowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
