import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { usageAccountGroups } from "./accounts";
import { UsageAccountsList } from "./accounts-list";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import { useUsageInSidebar } from "./in-sidebar";
import type { UsageReportEntry } from "./types";

/** One card per report (source + account). Window rows pin while the sidebar summary is on. */
export function UsageList({
  serverId,
  reports,
  display,
  onClose,
}: {
  serverId: string;
  reports: UsageReportEntry[];
  display: UsageDisplay;
  onClose?: () => void;
}) {
  const { inSidebar } = useUsageInSidebar();
  // Fork seam: ZeroSub's accounts lay out by provider (accounts-list.tsx).
  const accounts = usageAccountGroups(reports);
  if (accounts) {
    return (
      <UsageAccountsList
        serverId={serverId}
        reports={reports}
        accounts={accounts}
        display={display}
        onClose={onClose}
      />
    );
  }
  return (
    <View style={styles.list}>
      {reports.map((entry) => (
        <View key={entry.id} style={settingsStyles.card}>
          <UsageCard
            serverId={serverId}
            entry={entry}
            display={display}
            pinnable={inSidebar}
            refreshable
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[3],
  },
}));
