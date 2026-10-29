import type { QueryClient } from "@tanstack/react-query";
import type { UsageFeed, UsageFeedKind } from "./feed";
import { replaceReport, settleReports } from "./model";
import type { UsageReportEntry } from "./types";

function hostUsageQueryKey(serverId: string) {
  return ["usage", serverId] as const;
}

export function usageReportsQueryKey(serverId: string, kind: UsageFeedKind) {
  return [...hostUsageQueryKey(serverId), kind, "reports"] as const;
}

export function agentUsageQueryKey(serverId: string, kind: UsageFeedKind, agentId: string) {
  return [...hostUsageQueryKey(serverId), kind, "agent", agentId] as const;
}

interface RefreshReportInput {
  feed: Pick<UsageFeed, "kind" | "list">;
  queryClient: QueryClient;
  serverId: string;
  reportId: string;
  agentId?: string;
}

export async function refreshReport({
  feed,
  queryClient,
  serverId,
  reportId,
  agentId,
}: RefreshReportInput): Promise<void> {
  const options =
    agentId === undefined
      ? { reportIds: [reportId], forceRefresh: true }
      : { agentId, forceRefresh: true };
  const hostKey = usageReportsQueryKey(serverId, feed.kind);
  const queryKey =
    agentId === undefined ? hostKey : agentUsageQueryKey(serverId, feed.kind, agentId);
  // An agent list still streaming was scoped to the login before the refresh; drop it.
  if (agentId !== undefined) await queryClient.cancelQueries({ queryKey, exact: true });
  const refreshed = await feed.list(options);
  queryClient.setQueryData<UsageReportEntry[]>(queryKey, (reports) => {
    if (agentId !== undefined) return settleReports(reports, refreshed);
    const report = refreshed.find((entry) => entry.id === reportId) ?? null;
    return reports ? replaceReport(reports, reportId, report) : reports;
  });
  if (!refreshed.some((entry) => entry.id === reportId)) {
    void queryClient.invalidateQueries({ queryKey: hostKey, exact: true });
  }
}
