import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { addQuoteRpc, removeQuoteRpc, restoreQuoteRpc, setEnabledRpc } from "../shared/contracts";
import {
  dayLabel,
  MAX_QUOTE_LENGTH,
  rotation,
  type QuotesState,
  type RemovedQuote,
  type RotationRow,
} from "../shared/quotes";
import { today, useQuotes, useRefetchQuotes, useStoreQuotes } from "./quotes";

type Theme = PluginSurfaceProps["theme"];

function useStyles(theme: Theme) {
  return useMemo(() => {
    const { colors } = theme;
    const row = {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      paddingVertical: 7,
      paddingHorizontal: 12,
    };
    return {
      page: { gap: 12 },
      header: { paddingVertical: 8, paddingHorizontal: 12 },
      headerText: { fontSize: 11.5, color: colors.foregroundMuted },
      row,
      goneRow: { ...row, backgroundColor: colors.surface0 },
      when: { width: 74, fontSize: 11, color: colors.foregroundMuted },
      whenToday: { width: 74, fontSize: 11, color: colors.accent, fontWeight: "600" as const },
      text: { flex: 1, minWidth: 0, fontSize: 13, color: colors.foreground },
      goneText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        color: colors.foregroundMuted,
        textDecorationLine: "line-through" as const,
      },
      empty: { flex: 1, fontSize: 13, color: colors.foregroundMuted },
      remove: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 6 },
      removeText: { fontSize: 12, color: colors.foregroundMuted },
      undoText: { fontSize: 11.5, fontWeight: "600" as const, color: colors.accent },
      add: {
        flexDirection: "row" as const,
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 10,
        backgroundColor: colors.surface0,
      },
      input: {
        flex: 1,
        minWidth: 0,
        fontSize: 12.5,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
        color: colors.foreground,
      },
      addButton: {
        justifyContent: "center" as const,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: colors.foreground,
      },
      addText: { fontSize: 12, color: colors.surface0 },
    };
  }, [theme]);
}

type Styles = ReturnType<typeof useStyles>;

function QuoteRow({
  row,
  day,
  styles,
  disabled,
  onRemove,
}: {
  row: RotationRow;
  day: number;
  styles: Styles;
  disabled: boolean;
  onRemove(row: RotationRow): void;
}) {
  const remove = useCallback(() => onRemove(row), [onRemove, row]);
  return (
    <View style={styles.row} testID={`daily-quotes-row-${row.daysFromToday}`}>
      <Text style={row.daysFromToday === 0 ? styles.whenToday : styles.when}>
        {dayLabel(day, row.daysFromToday)}
      </Text>
      <Text style={styles.text}>{row.text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${row.text}`}
        disabled={disabled}
        onPress={remove}
        style={styles.remove}
        testID={`daily-quotes-remove-${row.daysFromToday}`}
      >
        <Text style={styles.removeText}>✕</Text>
      </Pressable>
    </View>
  );
}

function QuotesList({ state, theme }: { state: QuotesState; theme: Theme }) {
  const styles = useStyles(theme);
  const toast = useToast();
  const storeQuotes = useStoreQuotes();
  const refetchQuotes = useRefetchQuotes();
  const add = useRpc(addQuoteRpc);
  const remove = useRpc(removeQuoteRpc);
  const restore = useRpc(restoreQuoteRpc);
  const setEnabled = useRpc(setEnabledRpc);
  const [removed, setRemoved] = useState<RemovedQuote | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const day = today();
  const rows = rotation(state, day);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      try {
        await work();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        refetchQuotes();
      } finally {
        setBusy(false);
      }
    },
    [refetchQuotes, toast],
  );
  const toggle = useCallback(
    (enabled: boolean) => run(async () => storeQuotes(await setEnabled({ enabled }))),
    [run, setEnabled, storeQuotes],
  );
  const removeRow = useCallback(
    (row: RotationRow) =>
      run(async () => {
        const result = await remove({ index: row.index, text: row.text, day: today() });
        storeQuotes(result.state);
        setRemoved(result.removed);
      }),
    [remove, run, storeQuotes],
  );
  const undo = useCallback(() => {
    if (!removed) return;
    void run(async () => {
      storeQuotes(await restore({ removed, day: today() }));
      setRemoved(null);
    });
  }, [removed, restore, run, storeQuotes]);
  const addDraft = useCallback(() => {
    if (!draft.trim()) return;
    void run(async () => {
      storeQuotes(await add({ text: draft, day: today() }));
      setDraft("");
      setRemoved(null);
    });
  }, [add, draft, run, storeQuotes]);

  const count = `${rows.length} ${rows.length === 1 ? "quote" : "quotes"} · one a day`;
  return (
    <View style={styles.page}>
      <SettingsCard>
        <SettingsSwitch
          label="Show on New workspace"
          hint="The quote replaces the title"
          value={state.enabled}
          disabled={busy}
          onValueChange={toggle}
          testID="daily-quotes-enabled"
        />
      </SettingsCard>
      <SettingsCard testID="daily-quotes-list">
        <View style={styles.header}>
          <Text style={styles.headerText}>{count}</Text>
        </View>
        {rows.map((row) => (
          <QuoteRow
            key={`${row.index}:${row.text}`}
            row={row}
            day={day}
            styles={styles}
            disabled={busy}
            onRemove={removeRow}
          />
        ))}
        {removed ? (
          <View style={styles.goneRow} testID="daily-quotes-removed">
            <Text style={styles.when}>Removed</Text>
            <Text style={styles.goneText}>{removed.text}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Undo removing ${removed.text}`}
              disabled={busy}
              onPress={undo}
              testID="daily-quotes-undo"
            >
              <Text style={styles.undoText}>Undo</Text>
            </Pressable>
          </View>
        ) : null}
        {rows.length ? null : (
          <View style={styles.row}>
            <Text style={styles.empty}>
              No quotes yet. The title reads "New workspace" until you add one.
            </Text>
          </View>
        )}
        <View style={styles.add}>
          <TextInput
            accessibilityLabel="New quote"
            placeholder="Add a quote…"
            placeholderTextColor={theme.colors.foregroundMuted}
            maxLength={MAX_QUOTE_LENGTH}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addDraft}
            editable={!busy}
            style={styles.input}
            testID="daily-quotes-input"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add"
            disabled={busy}
            onPress={addDraft}
            style={styles.addButton}
            testID="daily-quotes-add"
          >
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>
      </SettingsCard>
    </View>
  );
}

export function DailyQuotesSettings({ theme }: PluginSurfaceProps) {
  const quotes = useQuotes();
  const retry = useCallback(() => void quotes.refetch(), [quotes]);
  if (quotes.isPending) return <Loading />;
  if (quotes.isError)
    return (
      <SettingsCard>
        <SettingsAction
          label="The quotes could not be read"
          hint={quotes.error.message}
          actionLabel="Try again"
          onPress={retry}
        />
      </SettingsCard>
    );
  return <QuotesList state={quotes.data} theme={theme} />;
}
