import { Pressable, ScrollView, Text, View } from "react-native";
import {
  ago,
  rows,
  sessionCount,
  type Camera,
  type Session,
  type Store,
  type Street,
} from "../shared/city";
import { toneColor, type Theme } from "./city-data";

function StoreTile({
  store,
  theme,
  here,
  compact,
  onPress,
}: {
  store: Store;
  theme: Theme;
  here: boolean;
  compact: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Store ${store.name}, ${sessionCount(store.sessions.length)}`}
      testID={`street-view-store-${store.id}`}
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: compact ? 22 : 64,
        padding: compact ? 4 : 8,
        borderRadius: 6,
        borderWidth: here ? 2 : 1,
        borderColor: here ? theme.colors.accent : theme.colors.border,
        borderLeftWidth: 4,
        borderLeftColor: toneColor(store.tone, theme),
        backgroundColor: theme.colors.surface1,
        gap: 4,
      }}
    >
      {!compact && (
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}
        >
          {store.name}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 3 }}>
        {store.sessions.map((session) => (
          <View
            key={session.id}
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: toneColor(session.tone, theme),
            }}
          />
        ))}
      </View>
    </Pressable>
  );
}

/** The walker on the map, pointing where it looks. */
function Walker({ theme, yaw }: { theme: Theme; yaw: number }) {
  return (
    <View
      testID="street-view-walker"
      style={{ alignSelf: "center", transform: [{ rotate: `${yaw}deg` }] }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 14, lineHeight: 16 }}>▲</Text>
    </View>
  );
}

/** One street from above: the road down the middle, a store on each side of each row. */
export function StreetColumn({
  street,
  index,
  theme,
  camera,
  compact = false,
  onStore,
}: {
  street: Street;
  index: number;
  theme: Theme;
  camera: Camera | null;
  compact?: boolean;
  onStore(index: number): void;
}) {
  const walker = camera?.street === index ? camera : null;
  return (
    <View
      testID={`street-view-street-${index}`}
      style={{ width: compact ? 150 : 260, gap: compact ? 3 : 6 }}
    >
      {!compact && (
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }}
        >
          {street.title}
        </Text>
      )}
      {walker?.slot === -1 && <Walker theme={theme} yaw={walker.yaw} />}
      {rows(street.stores).map(([left, right], slot) => (
        <View
          key={left.id}
          style={{ flexDirection: "row", alignItems: "stretch", gap: compact ? 3 : 6 }}
        >
          <StoreTile
            store={left}
            theme={theme}
            compact={compact}
            here={walker?.slot === slot}
            onPress={() => onStore(slot * 2)}
          />
          <View
            style={{
              width: compact ? 14 : 22,
              backgroundColor: theme.colors.surface2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {walker?.slot === slot ? (
              <Walker theme={theme} yaw={walker.yaw} />
            ) : (
              <View style={{ width: 2, height: "60%", backgroundColor: theme.colors.border }} />
            )}
          </View>
          {right ? (
            <StoreTile
              store={right}
              theme={theme}
              compact={compact}
              here={walker?.slot === slot}
              onPress={() => onStore(slot * 2 + 1)}
            />
          ) : (
            <View style={{ flex: 1 }} />
          )}
        </View>
      ))}
    </View>
  );
}

/** Every street side by side, seen from above. */
export function CityMap({
  streets,
  theme,
  camera,
  onStore,
}: {
  streets: readonly Street[];
  theme: Theme;
  camera: Camera;
  onStore(street: number, index: number): void;
}) {
  return (
    <ScrollView testID="street-view-map" contentContainerStyle={{ padding: 16, paddingTop: 84 }}>
      <ScrollView horizontal contentContainerStyle={{ gap: 28, alignItems: "flex-start" }}>
        {streets.map((street, index) => (
          <StreetColumn
            key={street.key}
            street={street}
            index={index}
            theme={theme}
            camera={camera}
            onStore={(store) => onStore(index, store)}
          />
        ))}
      </ScrollView>
    </ScrollView>
  );
}

function SessionRow({
  session,
  theme,
  onOpen,
}: {
  session: Session;
  theme: Theme;
  onOpen(session: Session): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open session ${session.name}`}
      testID={`street-view-session-${session.id}`}
      onPress={() => onOpen(session)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: toneColor(session.tone, theme),
        }}
      />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }}>
        {session.name}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {session.model} · {ago(session.updatedAt, Date.now())}
      </Text>
    </Pressable>
  );
}

/** Inside a store, on the map: its sessions as a list. */
export function StoreDetail({
  store,
  street,
  theme,
  compact,
  onOpen,
  onOpenWorkspace,
  onWalk,
  onClose,
}: {
  store: Store;
  street: Street;
  theme: Theme;
  compact: boolean;
  onOpen(session: Session): void;
  onOpenWorkspace(): void;
  onWalk: (() => void) | null;
  onClose(): void;
}) {
  const button = {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
  };
  const label = { color: theme.colors.foreground, fontSize: 12 };
  return (
    <View
      testID="street-view-store-detail"
      style={{
        position: "absolute",
        top: compact ? undefined : 64,
        right: compact ? 0 : 16,
        bottom: compact ? 0 : 16,
        left: compact ? 0 : undefined,
        width: compact ? undefined : 380,
        maxHeight: compact ? "60%" : undefined,
        padding: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: 8,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}
      >
        {store.name}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {[street.title, store.diff, sessionCount(store.sessions.length)]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          testID="street-view-open-workspace"
          onPress={onOpenWorkspace}
          style={button}
        >
          <Text style={label}>Open workspace</Text>
        </Pressable>
        {onWalk && (
          <Pressable
            accessibilityRole="button"
            testID="street-view-walk-in"
            onPress={onWalk}
            style={button}
          >
            <Text style={label}>Walk in (3D)</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          testID="street-view-close-store"
          onPress={onClose}
          style={button}
        >
          <Text style={label}>Close</Text>
        </Pressable>
      </View>
      <ScrollView>
        {store.sessions.length === 0 && (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No sessions</Text>
        )}
        {store.sessions.map((session) => (
          <SessionRow key={session.id} session={session} theme={theme} onOpen={onOpen} />
        ))}
      </ScrollView>
    </View>
  );
}
