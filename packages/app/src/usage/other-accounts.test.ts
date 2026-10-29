import { describe, expect, it } from "vitest";
import { asAgentAccount, fullestWindow, otherAccounts } from "./other-accounts";
import type { UsageAccountPresentation, UsageReportEntry, UsageWindow } from "./types";

const window = (id: string, label: string, usedPct: number): UsageWindow => ({
  id,
  label,
  usedPct,
  remainingPct: 100 - usedPct,
  resetsAt: null,
});
const presentation = (over: Partial<UsageAccountPresentation> = {}): UsageAccountPresentation => ({
  name: "Account",
  provider: "claude",
  isDefault: false,
  agents: 0,
  inUse: false,
  limitedUntil: null,
  signedOut: false,
  ...over,
});
const account = (
  id: string,
  windows: UsageWindow[],
  p: Partial<UsageAccountPresentation> = {},
): UsageReportEntry => ({
  id,
  account: {},
  fetchedAt: "2026-10-29T04:00:00.000Z",
  sourceId: "claude",
  sourceLabel: "Claude",
  report: { status: "available", planLabel: "Max", windows },
  presentation: presentation(p),
});

describe("the composer popover's accounts", () => {
  it("shows the window closest to its limit, never a model-scoped one", () => {
    const entry = account("z:a", [
      window("five_hour", "5-hour", 36),
      window("seven_day", "Weekly", 58),
      window("seven_day_opus", "Weekly · Fable", 99),
    ]);
    expect(fullestWindow(entry)?.id).toBe("seven_day");
    expect(fullestWindow(account("z:b", []))).toBeNull();
  });

  it("lists every signed-in account besides the agent's own, in the feed's order", () => {
    const own = account("z:own", []);
    const reports = [
      own,
      account("z:b", []),
      account("z:out", [], { signedOut: true }),
      account("z:c", []),
    ];
    expect(otherAccounts(reports, [own]).map((e) => e.id)).toEqual(["z:b", "z:c"]);
  });

  it("shows the agent's own account with its main windows, its agents in the footer and no read time", () => {
    const own = account(
      "z:own",
      [window("five_hour", "5-hour", 36), window("seven_day_opus", "Weekly · Fable", 0)],
      { inUse: true, agents: 94 },
    );
    const shown = asAgentAccount(own);
    expect(shown.presentation).toMatchObject({ inUse: false, agents: 94, omitReadTime: true });
    expect(shown.report.status === "available" && shown.report.windows.map((w) => w.id)).toEqual([
      "five_hour",
    ]);
    const daemon: UsageReportEntry = { ...own, presentation: undefined };
    expect(asAgentAccount(daemon)).toBe(daemon);
  });
});
