/**
 * The fiu.Storyboard panel: this workspace's newest board beside the chat, live. It docks in the Explorer (or a workspace
 * tab), follows the newest board until the reader steps back to an older one, and redraws when a `--watch` rerun
 * rewrites the board in place.
 *
 * The board runs as it does in Paseo's HTML preview: its own scripts on (the storyboard pans, swipes and keeps its
 * notes), in a sandbox that never shares Paseo's origin or session and cannot navigate the app. Its sticky notes reach
 * the host through fiu's own Paseo plugin (fiu-cli), whose board-notes bridge hears every frame on Paseo's page.
 */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import type { Board } from "../shared/boards";
import { readBoardPage } from "../shared/contracts";
import type { BoardsStore } from "./store";

type Theme = PluginWorkspacePanelProps["theme"];

/** What a board may do in its frame: what Paseo's own HTML preview allows, never `allow-same-origin`. */
const SANDBOX =
  "allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox";

export function makeStoryboardPanel(store: BoardsStore) {
  return function StoryboardPanel({ workspaceId, theme }: PluginWorkspacePanelProps) {
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const reading = useSyncExternalStore(store.subscribe, store.get);
    const boards = reading.workspaces?.[workspaceId] ?? [];
    // null follows the newest board; a board id holds the reader on that board.
    const [held, setHeld] = useState<string | null>(null);
    const heldAt = held ? boards.findIndex((board) => board.id === held) : -1;
    const index = heldAt >= 0 ? heldAt : 0;
    const board = boards[index];
    const step = (by: number) => {
      const next = boards[index + by];
      if (next) setHeld(index + by === 0 ? null : next.id);
    };

    if (reading.workspaces === null) {
      return (
        <Status
          theme={theme}
          text={
            reading.error
              ? `Could not read the mockups: ${reading.error}`
              : "Reading this workspace's mockups…"
          }
          danger={reading.error !== null}
        />
      );
    }
    if (!board) {
      return (
        <Status
          theme={theme}
          text="This workspace's board is empty. Every round an agent here runs with fiu mock or fiu sb goes on it, and shows here as it lands."
        />
      );
    }
    return (
      <View style={styles.panel} testID="fiu-mockups-panel">
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1} testID="fiu-mockups-title">
            {board.title}
          </Text>
          <Text
            style={styles.meta}
            testID="fiu-mockups-position"
          >{`${index + 1} of ${boards.length} · ${clock(board.modifiedAt)}`}</Text>
          <BarButton
            theme={theme}
            icon="ChevronLeft"
            label="Older mockup"
            testID="fiu-mockups-older"
            disabled={index >= boards.length - 1}
            onPress={() => step(1)}
          />
          <BarButton
            theme={theme}
            icon="ChevronRight"
            label="Newer mockup"
            testID="fiu-mockups-newer"
            disabled={index === 0}
            onPress={() => step(-1)}
          />
          {held !== null ? (
            <BarButton
              theme={theme}
              icon="ChevronsRight"
              label="Latest mockup"
              testID="fiu-mockups-latest"
              onPress={() => setHeld(null)}
            />
          ) : null}
        </View>
        {reading.error ? (
          <Text style={styles.warning}>{`Showing the last read: ${reading.error}`}</Text>
        ) : null}
        <BoardPage board={board} theme={theme} />
      </View>
    );
  };
}

function BoardPage({ board, theme }: { board: Board; theme: Theme }) {
  const read = useRpc(readBoardPage);
  // The write time is in the key: a --watch rerun rewrites the board under the same id.
  const page = useQuery({
    queryKey: ["fiu-storyboard", "board-page", board.id, board.modifiedAt],
    queryFn: () => read({ board: board.id }),
    staleTime: Infinity,
    gcTime: 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (Platform.OS !== "web")
    return (
      <Status
        theme={theme}
        text="A mockup runs in the web and desktop app; open this workspace there to see it."
      />
    );
  if (page.error)
    return (
      <Status
        theme={theme}
        text={`Could not open ${board.name}: ${page.error instanceof Error ? page.error.message : String(page.error)}`}
        danger
      />
    );
  if (!page.isPlaceholderData && page.data === null)
    return <Status theme={theme} text={`${board.name} is no longer on this host.`} danger />;
  if (!page.data) return <Status theme={theme} text={`Opening ${board.name}…`} />;
  return <BoardFrame html={page.data.html} title={board.title} />;
}

/**
 * The board in a sandboxed frame, from a `data:` URL as in Paseo's HTML preview, so it has no origin of its own: a
 * `blob:` URL would carry Paseo's origin, and a popup escaping the sandbox could run the board there. Chrome refuses a
 * top-level navigation to a `data:` URL, and fragment links still resolve inside the frame. Web only.
 */
function BoardFrame({ html, title }: { html: string; title: string }) {
  const url = useMemo(() => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, [html]);
  return (
    <iframe
      data-testid="fiu-mockups-frame"
      title={title}
      src={url}
      sandbox={SANDBOX}
      allow="clipboard-write; fullscreen"
      referrerPolicy="no-referrer"
      style={{ flex: 1, minHeight: 0, width: "100%", border: "none", backgroundColor: "white" }}
    />
  );
}

function BarButton({
  theme,
  icon,
  label,
  testID,
  disabled,
  onPress,
}: {
  theme: Theme;
  icon: string;
  label: string;
  testID: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        padding: 4,
        borderRadius: 6,
        opacity: disabled ? 0.35 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
    </Pressable>
  );
}

function Status({ theme, text, danger }: { theme: Theme; text: string; danger?: boolean }) {
  return (
    <View style={{ flex: 1, padding: 16 }} testID="fiu-mockups-status">
      <Text
        style={{
          color: danger ? theme.colors.statusDanger : theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 19,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function clock(at: number): string {
  const when = new Date(at);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString([], { month: "short", day: "numeric" });
}

function makeStyles(theme: Theme) {
  const c = theme.colors;
  return {
    panel: { flex: 1, minHeight: 0, backgroundColor: c.surface0 },
    bar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    title: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 13, fontWeight: "600" as const },
    meta: { color: c.foregroundMuted, fontSize: 12 },
    warning: { color: c.statusWarning, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4 },
  };
}
