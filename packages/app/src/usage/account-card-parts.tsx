import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatAgo, formatDurationUntil } from "./format";
import { UsageProviderIcon, UsageSourceIcon } from "./source-icon";
import type { UsageAccountPresentation, UsageReportEntry } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

// What a ZeroSub account adds to a usage card: its routing badges and its footer. The fork's own
// file; upstream's card.tsx renders these only for an entry with a presentation.

/** A card's icon and title: an account's own name and its provider's icon, else the source's. */
export function CardIdentity({
  entry,
  serverId,
  style,
}: {
  entry: UsageReportEntry;
  serverId: string;
  style: StyleProp<TextStyle>;
}) {
  const presentation = entry.presentation;
  return (
    <>
      {presentation && !entry.icon ? (
        <UsageProviderIcon provider={presentation.provider} serverId={serverId} size={14} />
      ) : (
        <UsageSourceIcon svg={entry.icon ?? null} size={14} />
      )}
      <Text style={style} numberOfLines={1}>
        {presentation?.name ?? entry.sourceLabel}
      </Text>
    </>
  );
}

/** An account's routing state: Default, In use with its agents, Limited until it comes back. */
export function AccountBadges({ entry }: { entry: UsageReportEntry }) {
  const { t } = useTranslation();
  const presentation = entry.presentation;
  const now = useRelativeTimeTick({ enabled: presentation?.limitedUntil != null });
  if (!presentation) return null;
  const back = formatDurationUntil(presentation.limitedUntil, now, t);
  return (
    <>
      {presentation.isDefault ? (
        <StatusBadge label={t("providerUsage.zeroSub.default")} variant="muted" size="xs" />
      ) : null}
      {presentation.inUse ? (
        <StatusBadge
          label={t("providerUsage.zeroSub.inUse", { count: presentation.agents })}
          variant="success"
          size="xs"
        />
      ) : null}
      {presentation.limitedUntil ? (
        <StatusBadge
          label={
            back
              ? t("providerUsage.zeroSub.limited", { duration: back })
              : t("providerUsage.zeroSub.limitedNow")
          }
          variant="error"
          size="xs"
        />
      ) : null}
    </>
  );
}

/** A card's footer: an account's own (AccountFooter), else the source's login and its freshness. */
export function CardFooter({
  entry,
  successfulAt,
  retained,
  showsFreshness,
  children,
  rowStyle,
  style,
}: {
  entry: UsageReportEntry;
  successfulAt: string | null;
  retained: boolean;
  showsFreshness: boolean;
  /** The source's freshness line, shown where the card has no Refresh tooltip. */
  children: ReactNode;
  rowStyle: StyleProp<ViewStyle>;
  style: StyleProp<TextStyle>;
}) {
  if (entry.presentation) {
    return (
      <AccountFooter
        entry={entry}
        presentation={entry.presentation}
        successfulAt={successfulAt}
        retained={retained}
      />
    );
  }
  const footer = entry.account.label ?? null;
  if (!footer && !showsFreshness) return null;
  return (
    <View style={rowStyle}>
      <Text style={style} numberOfLines={1}>
        {footer}
      </Text>
      {showsFreshness ? children : null}
    </View>
  );
}

/** Under an account: its email, its agents when no badge says them, and when it was last read. */
function AccountFooter({
  entry,
  presentation,
  successfulAt,
  retained,
}: {
  entry: UsageReportEntry;
  presentation: UsageAccountPresentation;
  successfulAt: string | null;
  retained: boolean;
}) {
  const { t } = useTranslation();
  const now = useRelativeTimeTick({ enabled: successfulAt != null });
  const ago = formatAgo(successfulAt, now, t);
  const email =
    entry.account.label && entry.account.label !== presentation.name ? entry.account.label : null;
  const agents =
    presentation.agents > 0 && !presentation.inUse
      ? t("providerUsage.zeroSub.agents", { count: presentation.agents })
      : null;
  const read = ago
    ? t(retained ? "providerUsage.zeroSub.lastRead" : "providerUsage.zeroSub.updated", {
        relativeTime: ago,
      })
    : null;
  const parts = [email, agents, read].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <Text style={styles.footer} numberOfLines={1} testID="usage-account-footer">
      {parts.join(" · ")}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
