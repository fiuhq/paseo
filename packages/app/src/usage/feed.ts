import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { i18n } from "@/i18n/i18next";
import { pluginRegistry, useHasPluginCatalog, useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { usageCopy } from "./copy";
import type { UsageAccountPresentation, UsageReportEntry, UsageWindow } from "./types";

/** What a usage view asks a host for: every report, one agent's, or a few by ID. */
export interface UsageFeedRequest {
  agentId?: string;
  forceRefresh?: boolean;
  reportIds?: string[];
}

export type OnUsageReport = (report: UsageReportEntry) => void;

/** Which feed a host's usage comes from; usage queries are keyed on it so an install refetches. */
export type UsageFeedKind = "zerosub" | "daemon";

/**
 * Where a host's usage reports come from. Every usage view (the Usage dialog, the composer's
 * popover, the sidebar summary) asks `UsageFeed.forHost`, never the daemon directly.
 */
export abstract class UsageFeed {
  abstract readonly kind: UsageFeedKind;

  abstract list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]>;

  /** ZeroSub's accounts when the host runs ZeroSub, else the daemon's own usage sources. */
  static forHost(serverId: string): UsageFeed {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) throw new Error(usageCopy.clientUnavailable);
    const daemon = new DaemonUsageFeed(client);
    const zeroSub = zeroSubPlugin(pluginRegistry.getSnapshot(), serverId);
    if (!zeroSub) return daemon;
    return new ZeroSubUsageFeed((method, input) => zeroSub.invoke(method, input), daemon);
  }
}

function zeroSubPlugin(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): InstalledPlugin | undefined {
  return plugins.find((plugin) => plugin.serverId === serverId && plugin.id === ZEROSUB_PLUGIN_ID);
}

/** The feed `UsageFeed.forHost` picks for a host, given the plugins installed right now. */
export function usageFeedKind(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): UsageFeedKind {
  return zeroSubPlugin(plugins, serverId) ? "zerosub" : "daemon";
}

/**
 * The host's feed kind, re-read when a plugin installs or goes away; null until a host that runs
 * plugins has settled its catalog, so a host-wide list never asks the daemon's sources first.
 */
export function useUsageFeedKind(serverId: string): UsageFeedKind | null {
  const plugins = useInstalledPlugins();
  const runsPlugins = useHostFeature(serverId, "plugins");
  const hasCatalog = useHasPluginCatalog(serverId);
  if (runsPlugins && !hasCatalog) return null;
  return usageFeedKind(plugins, serverId);
}

/** The daemon's usage sources, one per provider, each reading its provider's usage API. */
export class DaemonUsageFeed extends UsageFeed {
  readonly kind = "daemon";

  constructor(private readonly client: Pick<DaemonClient, "listUsageReports">) {
    super();
  }

  async list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]> {
    const { reports } = await this.client.listUsageReports(request, onReport);
    return reports;
  }
}

export const ZEROSUB_PLUGIN_ID = "zerosub";

// The daemon's own usage source per family, so pins saved on a daemon window keep matching.
const FAMILY_SOURCE_ID: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  kimi: "kimi",
  opencode: "opencode-go",
};

const ZeroSubWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

const ZeroSubAccountSchema = z.object({
  id: z.string(),
  family: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  status: z.string(),
  // Routing facts for the account's badges; optional so an older ZeroSub still reads.
  isDefault: z.boolean().optional(),
  agentCount: z.number().optional(),
  limitedUntil: z.string().nullable().optional(),
  usage: z
    .object({
      fetchedAt: z.string(),
      windows: z.array(ZeroSubWindowSchema),
      error: z.string().nullable(),
    })
    .nullable(),
});

const ZeroSubStateSchema = z.object({
  accounts: z.array(ZeroSubAccountSchema),
  agents: z.array(
    z.object({
      agentId: z.string(),
      accountId: z.string(),
      // The account the live session still runs on while a switch to `accountId` waits.
      pendingAccountId: z.string().nullable().optional(),
    }),
  ),
});

export type ZeroSubAccount = z.infer<typeof ZeroSubAccountSchema>;
type ZeroSubState = z.infer<typeof ZeroSubStateSchema>;

/**
 * ZeroSub's accounts, every one it holds, read through its own `zerosub.state`. ZeroSub reads each
 * account's usage itself (once, with its own backoff), so the host-wide list never asks the
 * daemon's usage sources and no provider usage API is called a second time. Only an agent ZeroSub
 * routes nowhere (a provider it does not hold) is asked of the daemon, for that agent alone.
 */
export class ZeroSubUsageFeed extends UsageFeed {
  readonly kind = "zerosub";

  constructor(
    private readonly invoke: (method: string, input: unknown) => Promise<unknown>,
    private readonly daemon: Pick<UsageFeed, "list">,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]> {
    const state = ZeroSubStateSchema.parse(
      await this.invoke("zerosub.state", { refreshUsage: request.forceRefresh === true }),
    );
    if (
      request.agentId !== undefined &&
      !state.agents.some((agent) => agent.agentId === request.agentId)
    ) {
      return this.daemon.list(request, onReport);
    }
    const sharing = providersWithSeveralAccounts(state.accounts);
    const reports = this.accountsFor(state, request).map((account) =>
      entryOf(account, this.now, sharing),
    );
    for (const report of reports) onReport?.(report);
    return reports;
  }

  private accountsFor(state: ZeroSubState, request: UsageFeedRequest): ZeroSubAccount[] {
    if (request.agentId !== undefined) {
      const route = state.agents.find((agent) => agent.agentId === request.agentId);
      const accountId = route?.pendingAccountId ?? route?.accountId;
      return state.accounts.filter((account) => account.id === accountId);
    }
    if (request.reportIds !== undefined) {
      const ids = new Set(request.reportIds);
      return state.accounts.filter((account) => ids.has(zeroSubReportId(account.id)));
    }
    return state.accounts;
  }
}

/** Providers ZeroSub holds more than one signed-in account of: there, "in use" tells them apart. */
function providersWithSeveralAccounts(accounts: readonly ZeroSubAccount[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    if (account.status === "signed_out") continue;
    counts.set(account.family, (counts.get(account.family) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([family]) => family));
}

function presentationOf(
  account: ZeroSubAccount,
  sharing: ReadonlySet<string>,
): UsageAccountPresentation {
  const agents = account.agentCount ?? 0;
  return {
    name: account.label,
    provider: account.family,
    isDefault: account.isDefault === true,
    agents,
    inUse: agents > 0 && sharing.has(account.family),
    limitedUntil: account.status === "limited" ? (account.limitedUntil ?? null) : null,
    signedOut: account.status === "signed_out",
  };
}

function entryOf(
  account: ZeroSubAccount,
  now: () => Date,
  sharing: ReadonlySet<string>,
): UsageReportEntry {
  const base = {
    presentation: presentationOf(account, sharing),
    id: zeroSubReportId(account.id),
    account: { label: account.email ?? account.label },
    sourceId: FAMILY_SOURCE_ID[account.family] ?? account.family,
    sourceLabel: i18n.t(`providerUsage.zeroSub.families.${account.family}`, {
      defaultValue: account.family,
    }),
  };
  const usage = account.usage;
  if (account.status === "signed_out" || !usage) {
    const detail = i18n.t(
      account.status === "signed_out"
        ? "providerUsage.zeroSub.signedOut"
        : "providerUsage.zeroSub.notRead",
    );
    return {
      ...base,
      fetchedAt: usage?.fetchedAt ?? now().toISOString(),
      report: { status: "unavailable", problem: { kind: "no_quota", detail } },
    };
  }
  const available = {
    status: "available" as const,
    ...(account.plan ? { planLabel: account.plan } : {}),
    windows: usage.windows.map((window, index) => {
      const shown: UsageWindow = {
        id: window.id,
        label: window.label,
        usedPct: window.usedPercent,
        remainingPct: Math.max(0, 100 - window.usedPercent),
        resetsAt: window.resetsAt,
      };
      // Where space is tight (the popover's other accounts, the sidebar): "5h", "week".
      const shortKey = `providerUsage.zeroSub.short.${window.id}`;
      if (i18n.exists(shortKey)) shown.shortLabel = i18n.t(shortKey);
      // The first window is the one the sidebar summary shows until windows are pinned.
      if (index === 0) shown.summary = true;
      return shown;
    }),
  };
  if (!usage.error) {
    return {
      ...base,
      fetchedAt: usage.fetchedAt,
      successfulAt: usage.fetchedAt,
      report: available,
    };
  }
  return {
    ...base,
    fetchedAt: usage.fetchedAt,
    report: { status: "error", error: usage.error },
    ...(available.windows.length > 0
      ? { lastSuccessful: { fetchedAt: usage.fetchedAt, report: available } }
      : {}),
  };
}

export function zeroSubReportId(accountId: string): string {
  return `zerosub:${accountId}`;
}
