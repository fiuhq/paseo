import { describe, expect, it } from "vitest";
import { isAccountNote, lastReadAt, signedOutNames, usageAccountGroups } from "./accounts";
import type { UsageAccountPresentation, UsageReportEntry } from "./types";

const presentation = (
  provider: string,
  over: Partial<UsageAccountPresentation> = {},
): UsageAccountPresentation => ({
  name: `${provider}-account`,
  provider,
  isDefault: false,
  agents: 0,
  inUse: false,
  limitedUntil: null,
  signedOut: false,
  ...over,
});
const entry = (
  id: string,
  label: string,
  p?: UsageAccountPresentation,
  successfulAt?: string,
): UsageReportEntry => ({
  id,
  account: {},
  fetchedAt: "2026-10-29T04:00:00.000Z",
  sourceId: id.split(":")[0]!,
  sourceLabel: label,
  report: { status: "available", windows: [] },
  ...(successfulAt ? { successfulAt } : {}),
  ...(p ? { presentation: p } : {}),
});

describe("usageAccountGroups", () => {
  it("groups ZeroSub's accounts by provider in ZeroSub's order, keeping each group's order, signed-out ones apart", () => {
    const reports = [
      entry("z:codex", "ChatGPT (Codex)", presentation("codex")),
      entry("z:kimi", "Kimi Code", presentation("kimi", { signedOut: true })),
      entry("z:c1", "Claude", presentation("claude", { name: "first" })),
      entry("z:open", "OpenCode Go", presentation("opencode")),
      entry("z:c2", "Claude", presentation("claude", { name: "second" })),
      entry("z:copilot", "GitHub Copilot", presentation("copilot", { signedOut: true })),
    ];
    const accounts = usageAccountGroups(reports)!;
    const ids = (group: { entries: UsageReportEntry[] }) => group.entries.map((e) => e.id);
    expect(accounts.groups.map((g) => [g.label, ids(g)])).toEqual([
      ["Claude", ["z:c1", "z:c2"]],
      ["ChatGPT (Codex)", ["z:codex"]],
      ["OpenCode Go", ["z:open"]],
    ]);
    expect(accounts.signedOut.map((e) => e.sourceLabel)).toEqual(["Kimi Code", "GitHub Copilot"]);
  });

  it("leaves the daemon's reports to today's flat list", () => {
    expect(usageAccountGroups([entry("claude:x", "Claude")])).toBeNull();
    expect(usageAccountGroups([])).toBeNull();
  });

  it("names signed-out accounts by provider, adding each account's name where a provider has several", () => {
    expect(
      signedOutNames([
        entry("z:kimi", "Kimi Code", presentation("kimi", { signedOut: true })),
        entry("z:c1", "Claude", presentation("claude", { name: "Account A", signedOut: true })),
        entry("z:copilot", "GitHub Copilot", presentation("copilot", { signedOut: true })),
        entry("z:c2", "Claude", presentation("claude", { name: "Account B", signedOut: true })),
      ]),
    ).toEqual(["Kimi Code", "Claude (Account A)", "GitHub Copilot", "Claude (Account B)"]);
  });

  it("dates the accounts by their newest successful reading", () => {
    expect(
      lastReadAt([
        entry("z:a", "A", presentation("claude"), "2026-10-29T03:00:00.000Z"),
        entry("z:b", "B", presentation("codex"), "2026-10-29T03:30:00.000Z"),
        entry("z:c", "C", presentation("kimi")),
      ]),
    ).toBe("2026-10-29T03:30:00.000Z");
  });
});

describe("isAccountNote", () => {
  const failed = (p?: UsageAccountPresentation, retained = false): UsageReportEntry => {
    const ok = entry("z:a", "OpenCode Go", p);
    return {
      ...ok,
      report: { status: "error", error: "OpenCode Go shows usage only in the OpenCode Console." },
      ...(retained
        ? {
            lastSuccessful: {
              fetchedAt: ok.fetchedAt,
              report: { status: "available", windows: [] },
            },
          }
        : {}),
    };
  };

  it("tells an account that was never read as a note", () => {
    expect(isAccountNote(failed(presentation("opencode")))).toBe(true);
  });

  it("keeps a failed re-read behind a retained reading, and the daemon's errors, as errors", () => {
    expect(isAccountNote(failed(presentation("codex"), true))).toBe(false);
    expect(isAccountNote(failed())).toBe(false);
    expect(isAccountNote(entry("z:b", "Claude", presentation("claude")))).toBe(false);
  });
});
