import { describe, expect, it } from "vitest";
import { DaemonUsageFeed, ZeroSubUsageFeed, zeroSubReportId } from "./feed";
import type { UsageFeedRequest } from "./feed";
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
  agents: [{ agentId: "a1", accountId: "claude-team" }],
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
            summary: true,
          },
        ],
      },
    });
  });

  it("gives an agent the account ZeroSub routes it to, without asking the daemon", async () => {
    const { zeroSub, daemonCalls } = feed();
    expect((await zeroSub.list({ agentId: "a1" })).map((r) => r.id)).toEqual([
      "zerosub:claude-team",
    ]);
    expect(daemonCalls).toEqual([]);
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
