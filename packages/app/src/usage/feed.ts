import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { pluginRegistry } from "@/plugins/registry";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { usageCopy } from "./copy";
import type { UsageReportEntry, UsageWindow } from "./types";

/** What a usage view asks a host for: every report, one agent's, or a few by ID. */
export interface UsageFeedRequest {
  agentId?: string;
  forceRefresh?: boolean;
  reportIds?: string[];
}

export type OnUsageReport = (report: UsageReportEntry) => void;

/**
 * Where a host's usage reports come from. Every usage view (the Usage dialog, the composer's
 * popover, the sidebar summary) asks `UsageFeed.forHost`, never the daemon directly.
 */
export abstract class UsageFeed {
  abstract list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]>;

  /** ZeroSub's accounts when the host runs ZeroSub, else the daemon's own usage sources. */
  static forHost(serverId: string): UsageFeed {
    const zeroSub = pluginRegistry
      .getSnapshot()
      .find((plugin) => plugin.serverId === serverId && plugin.id === ZEROSUB_PLUGIN_ID);
    if (zeroSub) return new ZeroSubUsageFeed((method, input) => zeroSub.invoke(method, input));
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) throw new Error(usageCopy.clientUnavailable);
    return new DaemonUsageFeed(client);
  }
}

/** The daemon's usage sources, one per provider, each reading its provider's usage API. */
export class DaemonUsageFeed extends UsageFeed {
  constructor(private readonly client: Pick<DaemonClient, "listUsageReports">) {
    super();
  }

  async list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]> {
    const { reports } = await this.client.listUsageReports(request, onReport);
    return reports;
  }
}

export const ZEROSUB_PLUGIN_ID = "zerosub";

const FAMILY_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  kimi: "Kimi Code",
  copilot: "GitHub Copilot",
  opencode: "OpenCode Go",
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
  isDefault: z.boolean(),
  limitedUntil: z.string().nullable(),
  agentCount: z.number(),
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
  agents: z.array(z.object({ agentId: z.string(), accountId: z.string() })),
});

export type ZeroSubAccount = z.infer<typeof ZeroSubAccountSchema>;
type ZeroSubState = z.infer<typeof ZeroSubStateSchema>;

/**
 * ZeroSub's accounts, every one it holds, read through its own `zerosub.state`. ZeroSub reads each
 * account's usage itself (once, with its own backoff), so the daemon's usage sources are never
 * asked and no provider usage API is called a second time.
 */
export class ZeroSubUsageFeed extends UsageFeed {
  constructor(
    private readonly invoke: (method: string, input: unknown) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async list(request: UsageFeedRequest, onReport?: OnUsageReport): Promise<UsageReportEntry[]> {
    const state = ZeroSubStateSchema.parse(
      await this.invoke("zerosub.state", { refreshUsage: request.forceRefresh === true }),
    );
    const reports = this.accountsFor(state, request).map((account) => this.entryOf(account));
    for (const report of reports) onReport?.(report);
    return reports;
  }

  private accountsFor(state: ZeroSubState, request: UsageFeedRequest): ZeroSubAccount[] {
    if (request.agentId !== undefined) {
      const route = state.agents.find((agent) => agent.agentId === request.agentId);
      return state.accounts.filter((account) => account.id === route?.accountId);
    }
    if (request.reportIds !== undefined) {
      const ids = new Set(request.reportIds);
      return state.accounts.filter((account) => ids.has(zeroSubReportId(account.id)));
    }
    return state.accounts;
  }

  private entryOf(account: ZeroSubAccount): UsageReportEntry {
    const fetchedAt = account.usage?.fetchedAt ?? this.now().toISOString();
    const base = {
      id: zeroSubReportId(account.id),
      account: { label: account.email ?? account.label },
      fetchedAt,
      sourceId: `zerosub-${account.family}`,
      sourceLabel: FAMILY_LABEL[account.family] ?? account.family,
    };
    if (account.status === "signed_out") {
      return {
        ...base,
        report: {
          status: "unavailable",
          problem: { kind: "no_quota", detail: "Signed out in ZeroSub" },
        },
      };
    }
    const windows = account.usage?.windows ?? [];
    if (windows.length === 0 && account.usage?.error) {
      return { ...base, report: { status: "error", error: account.usage.error } };
    }
    return {
      ...base,
      ...(account.usage && !account.usage.error ? { successfulAt: account.usage.fetchedAt } : {}),
      report: {
        status: "available",
        ...(account.plan ? { planLabel: account.plan } : {}),
        windows: windows.map((window, index) => {
          const shown: UsageWindow = {
            id: window.id,
            label: window.label,
            usedPct: window.usedPercent,
            remainingPct: Math.max(0, 100 - window.usedPercent),
            resetsAt: window.resetsAt,
          };
          // The first window is the one the sidebar summary shows until windows are pinned.
          if (index === 0) shown.summary = true;
          return shown;
        }),
      },
    };
  }
}

export function zeroSubReportId(accountId: string): string {
  return `zerosub:${accountId}`;
}
