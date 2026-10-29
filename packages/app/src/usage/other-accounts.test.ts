import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { accountNote, asAgentAccount, fullestWindow, otherAccounts } from "./other-accounts";
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

  it("shows the main windows a failed re-read kept for the agent's own account", () => {
    const own = account("z:own", [], { agents: 1 });
    const failed: UsageReportEntry = {
      ...own,
      report: { status: "error", error: "HTTP 429" },
      lastSuccessful: {
        fetchedAt: own.fetchedAt,
        report: {
          status: "available",
          windows: [
            window("five_hour", "5-hour", 90),
            window("seven_day_opus", "Weekly · Fable", 99),
          ],
        },
      },
    };
    const shown = asAgentAccount(failed);
    expect(shown.report).toEqual({ status: "error", error: "HTTP 429" });
    expect(shown.lastSuccessful?.report.windows.map((w) => w.id)).toEqual(["five_hour"]);
    expect(fullestWindow(failed)?.id).toBe("five_hour");
  });

  it("says Console only for an account never read, and Not read yet for one ZeroSub has not read", () => {
    const base = account("z:a", []);
    const unreadable: UsageReportEntry = { ...base, report: { status: "error", error: "e" } };
    const unread: UsageReportEntry = {
      ...base,
      report: { status: "unavailable", problem: { kind: "no_quota", detail: "not read" } },
    };
    const retained: UsageReportEntry = {
      ...unreadable,
      lastSuccessful: { fetchedAt: base.fetchedAt, report: { status: "available", windows: [] } },
    };
    expect(accountNote(unreadable, i18n.t)).toBe("Console only");
    expect(accountNote(unread, i18n.t)).toBe("Not read yet");
    expect(accountNote(retained, i18n.t)).toBeNull();
    expect(accountNote(base, i18n.t)).toBeNull();
  });
});
