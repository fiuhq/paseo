import { describe, expect, it } from "vitest";
import { DaemonUsageFeed, ZeroSubUsageFeed, zeroSubReportId } from "./feed";
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
  label: "huytuong1804",
  email: "huytuong1804@gmail.com",
  plan: "Max",
  status: "ready",
  isDefault: false,
  limitedUntil: null,
  agentCount: 94,
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
      id: "claude-2bfb",
      label: "phieu",
      email: "phieu@flxbl.io",
      plan: "Team",
      status: "limited",
      agentCount: 0,
    }),
    account({
      id: "kimi-main",
      family: "kimi",
      label: "Kimi (CLI login)",
      email: null,
      plan: null,
      status: "signed_out",
      agentCount: 0,
      usage: null,
    }),
    account({
      id: "opencode-main",
      family: "opencode",
      label: "OpenCode Go 1",
      email: null,
      plan: "Go",
      agentCount: 1,
      usage: {
        fetchedAt: "2026-10-29T02:54:00.000Z",
        windows: [],
        error: "OpenCode Go shows usage only in the OpenCode Console.",
      },
    }),
  ],
  agents: [{ agentId: "a1", accountId: "claude-2bfb" }],
};

function feed() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const zeroSub = new ZeroSubUsageFeed(
    async (method, input) => {
      calls.push({ method, input });
      return state;
    },
    () => new Date("2026-10-29T04:00:00.000Z"),
  );
  return { zeroSub, calls };
}

describe("ZeroSubUsageFeed", () => {
  it("reports every account ZeroSub holds, one entry each, from its one state read", async () => {
    const { zeroSub, calls } = feed();
    const streamed: string[] = [];
    const reports = await zeroSub.list({}, (report) => streamed.push(report.id));
    expect(calls).toEqual([{ method: "zerosub.state", input: { refreshUsage: false } }]);
    expect(reports.map((r) => [r.id, r.sourceId, r.sourceLabel, r.account.label])).toEqual([
      ["zerosub:claude-main", "zerosub-claude", "Claude", "huytuong1804@gmail.com"],
      ["zerosub:claude-2bfb", "zerosub-claude", "Claude", "phieu@flxbl.io"],
      ["zerosub:kimi-main", "zerosub-kimi", "Kimi Code", "Kimi (CLI login)"],
      ["zerosub:opencode-main", "zerosub-opencode", "OpenCode Go", "OpenCode Go 1"],
    ]);
    expect(streamed).toEqual(reports.map((r) => r.id));
  });

  it("maps a reading to the plan and its windows, and says when an account is signed out or unreadable", async () => {
    const [claude, , kimi, opencode] = await feed().zeroSub.list({});
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
          summary: true,
        },
        {
          id: "seven_day",
          label: "Weekly",
          usedPct: 58,
          remainingPct: 42,
          resetsAt: "2026-10-29T05:00:00.000Z",
        },
      ],
    });
    expect(claude!.successfulAt).toBe("2026-10-29T03:00:00.000Z");
    expect(kimi!.report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "Signed out in ZeroSub" },
    });
    expect(kimi!.fetchedAt).toBe("2026-10-29T04:00:00.000Z");
    expect(opencode!.report).toEqual({
      status: "error",
      error: "OpenCode Go shows usage only in the OpenCode Console.",
    });
  });

  it("gives an agent the account ZeroSub routes it to, and none when ZeroSub routes it nowhere", async () => {
    const { zeroSub } = feed();
    expect((await zeroSub.list({ agentId: "a1" })).map((r) => r.id)).toEqual([
      "zerosub:claude-2bfb",
    ]);
    expect(await zeroSub.list({ agentId: "elsewhere" })).toEqual([]);
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

  it("fails loudly on a state it cannot read rather than showing no accounts", async () => {
    const broken = new ZeroSubUsageFeed(async () => ({ accounts: "nope" }));
    await expect(broken.list({})).rejects.toThrow();
  });
});

describe("DaemonUsageFeed", () => {
  it("asks the daemon's usage sources and streams what they send", async () => {
    const sent: UsageReportEntry[] = [];
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
        sent.push(entry);
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
