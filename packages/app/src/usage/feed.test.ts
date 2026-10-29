import { describe, expect, it } from "vitest";
import { DaemonUsageFeed, ZeroSubUsageFeed, usageFeedKind, zeroSubReportId } from "./feed";
import type { UsageFeedRequest } from "./feed";
import type { InstalledPlugin } from "@/plugins/types";
import type { UsageReportEntry } from "./types";

const window = (id: string, label: string, usedPercent: number) => ({
  id,
  label,
  usedPercent,
  resetsAt: "2026-10-29T05:00:00.000Z",
});
const account = (over: Record<string, unknown>) => ({
  id: "claude-main",
  family: "claude",
  label: "Account A",
  email: "a@example.com",
  plan: "Max",
  status: "ready",
  usage: {
    fetchedAt: "2026-10-29T03:00:00.000Z",
    windows: [window("five_hour", "5-hour", 36), window("seven_day", "Weekly", 58)],
    error: null,
  },
  ...over,
});
const state = {
  accounts: [
    account({}),
    account({
      id: "claude-team",
      label: "Account B",
      email: "b@example.com",
      plan: "Team",
      status: "limited",
    }),
    account({
      id: "kimi-main",
      family: "kimi",
      label: "Kimi login",
      email: null,
      plan: null,
      status: "signed_out",
      usage: null,
    }),
    account({
      id: "opencode-main",
      family: "opencode",
      label: "OpenCode account",
      email: null,
      plan: "Go",
      usage: {
        fetchedAt: "2026-10-29T02:54:00.000Z",
        windows: [],
        error: "OpenCode Go shows usage only in the OpenCode Console.",
      },
    }),
    account({
      id: "codex-main",
      family: "codex",
      label: "Codex account",
      email: null,
      plan: null,
      usage: {
        fetchedAt: "2026-10-29T03:30:00.000Z",
        windows: [window("five_hour", "5-hour", 90)],
        error: "HTTP 429",
      },
    }),
    account({
      id: "copilot-main",
      family: "copilot",
      label: "Copilot account",
      email: null,
      plan: null,
      usage: null,
    }),
  ],
  agents: [
    { agentId: "a1", accountId: "claude-team" },
    { agentId: "a2", accountId: "claude-team", pendingAccountId: "claude-main" },
  ],
};

const daemonEntry = {
  id: "zai:x",
  account: {},
  fetchedAt: "2026-10-29T03:00:00.000Z",
  sourceId: "zai",
  sourceLabel: "Z.AI",
  report: { status: "error", error: "e" },
} as UsageReportEntry;

function feed() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const daemonCalls: UsageFeedRequest[] = [];
  const zeroSub = new ZeroSubUsageFeed(
    async (method, input) => {
      calls.push({ method, input });
      return state;
    },
    {
      async list(request, onReport) {
        daemonCalls.push(request);
        onReport?.(daemonEntry);
        return [daemonEntry];
      },
    },
    () => new Date("2026-10-29T04:00:00.000Z"),
  );
  return { zeroSub, calls, daemonCalls };
}

describe("ZeroSubUsageFeed", () => {
  it("reports every account ZeroSub holds under the daemon's source for its provider, from one state read", async () => {
    const { zeroSub, calls, daemonCalls } = feed();
    const streamed: string[] = [];
    const reports = await zeroSub.list({}, (report) => streamed.push(report.id));
    expect(calls).toEqual([{ method: "zerosub.state", input: { refreshUsage: false } }]);
    expect(daemonCalls).toEqual([]);
    expect(reports.map((r) => [r.id, r.sourceId, r.sourceLabel, r.account.label])).toEqual([
      ["zerosub:claude-main", "claude", "Claude", "a@example.com"],
      ["zerosub:claude-team", "claude", "Claude", "b@example.com"],
      ["zerosub:kimi-main", "kimi", "Kimi Code", "Kimi login"],
      ["zerosub:opencode-main", "opencode-go", "OpenCode Go", "OpenCode account"],
      ["zerosub:codex-main", "codex", "ChatGPT (Codex)", "Codex account"],
      ["zerosub:copilot-main", "copilot", "GitHub Copilot", "Copilot account"],
    ]);
    expect(streamed).toEqual(reports.map((r) => r.id));
  });

  it("maps a reading to the plan and its windows, and says when an account is signed out, unread or unreadable", async () => {
    const [claude, , kimi, opencode, , copilot] = await feed().zeroSub.list({});
    expect(claude!.report).toEqual({
      status: "available",
      planLabel: "Max",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          usedPct: 36,
          remainingPct: 64,
          resetsAt: "2026-10-29T05:00:00.000Z",
          shortLabel: "5h",
          summary: true,
        },
        {
          id: "seven_day",
          label: "Weekly",
          usedPct: 58,
          remainingPct: 42,
          resetsAt: "2026-10-29T05:00:00.000Z",
          shortLabel: "week",
        },
      ],
    });
    expect(claude!.successfulAt).toBe("2026-10-29T03:00:00.000Z");
    expect(kimi!.report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "Signed out in ZeroSub" },
    });
    expect(kimi!.fetchedAt).toBe("2026-10-29T04:00:00.000Z");
    expect(copilot!.report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "ZeroSub has not read this account's usage yet" },
    });
    expect(copilot!.successfulAt).toBeUndefined();
    expect(opencode!.report).toEqual({
      status: "error",
      error: "OpenCode Go shows usage only in the OpenCode Console.",
    });
    expect(opencode!.lastSuccessful).toBeUndefined();
  });

  it("keeps the windows of a failed reading as a retained snapshot behind the error, never as a fresh reading", async () => {
    const codex = (await feed().zeroSub.list({})).find((r) => r.id === "zerosub:codex-main")!;
    expect(codex.report).toEqual({ status: "error", error: "HTTP 429" });
    expect(codex.successfulAt).toBeUndefined();
    expect(codex.lastSuccessful).toEqual({
      fetchedAt: "2026-10-29T03:30:00.000Z",
      report: {
        status: "available",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            usedPct: 90,
            remainingPct: 10,
            resetsAt: "2026-10-29T05:00:00.000Z",
            shortLabel: "5h",
            summary: true,
          },
        ],
      },
    });
  });

  it("gives a window a short name only where ZeroSub's short names hold one", async () => {
    const monthly = account({
      usage: {
        fetchedAt: "2026-10-29T03:00:00.000Z",
        windows: [window("five_hour", "5-hour", 36), window("monthly", "Monthly", 10)],
        error: null,
      },
    });
    const zeroSub = new ZeroSubUsageFeed(
      async () => ({ accounts: [monthly], agents: [] }),
      { list: async () => [] },
      () => new Date("2026-10-29T04:00:00.000Z"),
    );
    const [entry] = await zeroSub.list({});
    const windows = entry!.report.status === "available" ? entry!.report.windows : [];
    expect(windows.map((w) => w.shortLabel)).toEqual(["5h", undefined]);
  });

  it("gives an agent the account ZeroSub routes it to, without asking the daemon", async () => {
    const { zeroSub, daemonCalls } = feed();
    expect((await zeroSub.list({ agentId: "a1" })).map((r) => r.id)).toEqual([
      "zerosub:claude-team",
    ]);
    expect(daemonCalls).toEqual([]);
  });

  it("gives an agent waiting on a switch the account its live session still runs on", async () => {
    expect((await feed().zeroSub.list({ agentId: "a2" })).map((r) => r.id)).toEqual([
      "zerosub:claude-main",
    ]);
  });

  it("asks the daemon for an agent ZeroSub routes nowhere, for that agent alone", async () => {
    const { zeroSub, daemonCalls } = feed();
    const streamed: UsageReportEntry[] = [];
    const request = { agentId: "elsewhere", forceRefresh: true };
    expect(await zeroSub.list(request, (r) => streamed.push(r))).toEqual([daemonEntry]);
    expect(daemonCalls).toEqual([request]);
    expect(streamed).toEqual([daemonEntry]);
  });

  it("refreshes through ZeroSub's own read, and answers only the reports asked for", async () => {
    const { zeroSub, calls } = feed();
    const reports = await zeroSub.list({
      reportIds: [zeroSubReportId("opencode-main")],
      forceRefresh: true,
    });
    expect(calls[0]!.input).toEqual({ refreshUsage: true });
    expect(reports.map((r) => r.id)).toEqual(["zerosub:opencode-main"]);
  });

  it("presents each account by its own name, with Default, In use (only where several accounts share a provider) and Limited", async () => {
    const routed = new ZeroSubUsageFeed(
      async () => ({
        accounts: [
          account({ agentCount: 94 }),
          account({
            id: "claude-team",
            label: "Account B",
            status: "limited",
            limitedUntil: "2026-10-29T05:00:00.000Z",
            agentCount: 0,
          }),
          account({ id: "claude-spare", label: "Account C", isDefault: true, agentCount: 0 }),
          account({
            id: "opencode-main",
            family: "opencode",
            label: "OpenCode account",
            email: null,
            agentCount: 1,
          }),
          account({
            id: "kimi-main",
            family: "kimi",
            label: "Kimi login",
            status: "signed_out",
            usage: null,
          }),
        ],
        agents: [],
      }),
      { list: async () => [] },
    );
    const presented = (await routed.list({})).map((r) => r.presentation);
    expect(presented).toEqual([
      {
        name: "Account A",
        provider: "claude",
        isDefault: false,
        agents: 94,
        inUse: true,
        limitedUntil: null,
        signedOut: false,
      },
      {
        name: "Account B",
        provider: "claude",
        isDefault: false,
        agents: 0,
        inUse: false,
        limitedUntil: "2026-10-29T05:00:00.000Z",
        signedOut: false,
      },
      {
        name: "Account C",
        provider: "claude",
        isDefault: true,
        agents: 0,
        inUse: false,
        limitedUntil: null,
        signedOut: false,
      },
      // The only OpenCode account: its agent is told in the footer, not by an In use badge.
      {
        name: "OpenCode account",
        provider: "opencode",
        isDefault: false,
        agents: 1,
        inUse: false,
        limitedUntil: null,
        signedOut: false,
      },
      {
        name: "Kimi login",
        provider: "kimi",
        isDefault: false,
        agents: 0,
        inUse: false,
        limitedUntil: null,
        signedOut: true,
      },
    ]);
  });

  it("counts only signed-in accounts when deciding whether a provider's account is In use", async () => {
    const routed = new ZeroSubUsageFeed(
      async () => ({
        accounts: [
          account({ agentCount: 3 }),
          account({ id: "claude-team", label: "Account B", status: "signed_out", usage: null }),
        ],
        agents: [],
      }),
      { list: async () => [] },
    );
    const [only] = await routed.list({});
    expect(only!.presentation).toMatchObject({ name: "Account A", agents: 3, inUse: false });
  });

  it("fails loudly on a state it cannot read rather than showing no accounts", async () => {
    const broken = new ZeroSubUsageFeed(async () => ({ accounts: "nope" }), {
      list: async () => [],
    });
    await expect(broken.list({})).rejects.toThrow();
  });
});

describe("DaemonUsageFeed", () => {
  it("asks the daemon's usage sources and streams what they send", async () => {
    const entry = {
      id: "claude:x",
      account: {},
      fetchedAt: "t",
      sourceId: "claude",
      sourceLabel: "Claude",
      report: { status: "error", error: "e" },
    } as UsageReportEntry;
    const client = {
      async listUsageReports(options: unknown, onReport?: (r: UsageReportEntry) => void) {
        onReport?.(entry);
        expect(options).toEqual({ agentId: "a1" });
        return { requestId: "r", reports: [entry] };
      },
    };
    const streamed: UsageReportEntry[] = [];
    expect(
      await new DaemonUsageFeed(client as never).list({ agentId: "a1" }, (r) => streamed.push(r)),
    ).toEqual([entry]);
    expect(streamed).toEqual([entry]);
  });
});

describe("usageFeedKind", () => {
  const plugin = (serverId: string, id: string) => ({ serverId, id }) as InstalledPlugin;

  it("picks ZeroSub only for the host whose ZeroSub plugin is installed", () => {
    const plugins = [plugin("host-a", "zerosub"), plugin("host-b", "other")];
    expect(usageFeedKind(plugins, "host-a")).toBe("zerosub");
    expect(usageFeedKind(plugins, "host-b")).toBe("daemon");
    expect(usageFeedKind([], "host-a")).toBe("daemon");
  });
});
