import { useMemo } from "react";
import { Text, View } from "react-native";
import type { PluginNewWorkspaceTitleProps } from "@getpaseo/plugin/client";
import { todayQuote } from "../shared/quotes";
import { today, useQuotes } from "./quotes";

/**
 * Today's quote as the New workspace headline. Renders nothing while loading, with no quotes, or
 * with the switch off, so the screen keeps its own "New workspace" title.
 */
export function QuoteTitle({ theme }: PluginNewWorkspaceTitleProps) {
  const quotes = useQuotes();
  const styles = useMemo(
    () => ({
      eyebrow: {
        fontSize: 11,
        letterSpacing: 0.2,
        marginBottom: 5,
        color: theme.colors.foregroundMuted,
      },
      // ponytail: the app's 2xl title size at the default font scale; plugin themes carry no type scale.
      quote: { fontSize: 20, fontWeight: "500" as const, color: theme.colors.foreground },
      mark: { color: theme.colors.accent },
    }),
    [theme],
  );
  const quote = quotes.data?.enabled ? todayQuote(quotes.data, today()) : null;
  if (!quote) return null;
  return (
    <View testID="daily-quotes-title">
      <Text style={styles.eyebrow}>NEW WORKSPACE · TODAY</Text>
      <Text style={styles.quote}>
        <Text style={styles.mark}>{"“"}</Text>
        {quote}
        <Text style={styles.mark}>{"”"}</Text>
      </Text>
    </View>
  );
}
