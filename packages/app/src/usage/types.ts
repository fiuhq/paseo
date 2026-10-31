import type {
  ProviderUsageTone,
  UsageReportEntry as ProtocolUsageReportEntry,
} from "@getpaseo/protocol/messages";

/**
 * How an account-routing feed (ZeroSub) presents one of its accounts: the account's own name over
 * the provider's, the provider whose icon it wears, and its routing state. The daemon's entries
 * carry none and render as before.
 */
export interface UsageAccountPresentation {
  /** The account's own name, the card's title. */
  name: string;
  /** The provider the account belongs to (`claude`, `codex`, …), for its icon and its group. */
  provider: string;
  isDefault: boolean;
  /** Agents running on the account now. */
  agents: number;
  /** Several accounts share the provider and agents run on this one. */
  inUse: boolean;
  /** When the account is limited, when it comes back. */
  limitedUntil: string | null;
  signedOut: boolean;
  /** The card leaves out when the account was last read (the composer popover, which has Refresh). */
  omitReadTime?: boolean;
}

export type UsageReportEntry = ProtocolUsageReportEntry & {
  presentation?: UsageAccountPresentation;
};
export type UsageReport = UsageReportEntry["report"];
export type UsageTone = ProviderUsageTone;
export type AvailableUsageReport = Extract<UsageReport, { status: "available" }>;
export type UsageWindow = AvailableUsageReport["windows"][number];
export type UsageBalance = NonNullable<AvailableUsageReport["balances"]>[number];
export type UsageBalanceUnit = UsageBalance["unit"];

/** What a host's usage surface shows. `unavailable` is a host state, not a failed request. */
export type UsageView =
  | { kind: "off"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[]; isRefreshing: boolean };
