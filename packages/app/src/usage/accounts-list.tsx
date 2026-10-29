import { router } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { settingsStyles } from "@/styles/settings";
import { lastReadAt, signedOutNames, usageAccountGroups, type UsageAccountGroup } from "./accounts";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { ZEROSUB_PLUGIN_ID } from "./feed";
import { formatAgo } from "./format";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageReportEntry } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

/**
 * The Usage dialog's list when its reports are ZeroSub's accounts: grouped by provider under one
 * line saying where they were read, the signed-out accounts sharing one line at the end. The fork's
 * own file; upstream's list.tsx hands over to it.
 */
export function UsageAccountsList({
  serverId,
  reports,
  accounts,
  display,
  onClose,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  accounts: NonNullable<ReturnType<typeof usageAccountGroups>>;
  display: UsageDisplay;
  onClose?: () => void;
}) {
  return (
    <View style={styles.list} testID="usage-accounts">
      <ReadThrough reports={reports} />
      {accounts.groups.map((group) => (
        <AccountGroup key={group.provider} serverId={serverId} group={group} display={display} />
      ))}
      {accounts.signedOut.length > 0 ? (
        <SignedOut serverId={serverId} entries={accounts.signedOut} onClose={onClose} />
      ) : null}
    </View>
  );
}

function ReportCard({
  serverId,
  entry,
  display,
}: {
  serverId: string;
  entry: UsageReportEntry;
  display: UsageDisplay;
}) {
  const { inSidebar } = useUsageInSidebar();
  return (
    <View style={settingsStyles.card}>
      <UsageCard
        serverId={serverId}
        entry={entry}
        display={display}
        pinnable={inSidebar}
        refreshable
      />
    </View>
  );
}

/** Where the accounts were read, and when. */
function ReadThrough({ reports }: { reports: readonly UsageReportEntry[] }) {
  const { t } = useTranslation();
  const at = lastReadAt(reports);
  const now = useRelativeTimeTick({ enabled: at != null });
  const ago = formatAgo(at, now, t);
  return (
    <Text style={styles.muted} testID="usage-accounts-source">
      {ago
        ? t("providerUsage.zeroSub.readThrough", { relativeTime: ago })
        : t("providerUsage.zeroSub.readThroughNever")}
    </Text>
  );
}

function AccountGroup({
  serverId,
  group,
  display,
}: {
  serverId: string;
  group: UsageAccountGroup;
  display: UsageDisplay;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.group} testID={`usage-accounts-${group.provider}`}>
      <View style={styles.groupHeading}>
        <Text style={styles.groupTitle}>{group.label}</Text>
        {group.entries.length > 1 ? (
          <Text style={styles.muted}>
            {t("providerUsage.zeroSub.accountCount", { count: group.entries.length })}
          </Text>
        ) : null}
      </View>
      {group.entries.map((entry) => (
        <ReportCard key={entry.id} serverId={serverId} entry={entry} display={display} />
      ))}
    </View>
  );
}

/** The signed-out accounts, named on one line, with the way to sign them in. */
function SignedOut({
  serverId,
  entries,
  onClose,
}: {
  serverId: string;
  entries: UsageReportEntry[];
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const names = signedOutNames(entries).join(", ");
  const openAccounts = useCallback(() => {
    onClose?.();
    router.push(
      buildPluginSurfaceRoute(serverId, ZEROSUB_PLUGIN_ID, { kind: "sidebar", id: "accounts" }),
    );
  }, [onClose, serverId]);
  return (
    <View style={styles.signedOut} testID="usage-accounts-signed-out">
      <Text style={styles.muted} numberOfLines={1}>
        {t("providerUsage.zeroSub.signedOutLine", { names })}
      </Text>
      <Button variant="ghost" size="sm" onPress={openAccounts} testID="usage-accounts-sign-in">
        {t("providerUsage.zeroSub.signIn")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
  },
  group: {
    gap: theme.spacing[3],
  },
  groupHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: theme.spacing[1],
  },
  groupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  signedOut: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
}));
