import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import {
  ENTRANCE,
  cameraAt,
  step,
  storeFaced,
  type Camera,
  type Move,
  type Session,
  type Street,
} from "../shared/city";
import { useCity, type Theme } from "./city-data";
import { CityMap, StoreDetail, StreetColumn } from "./map";
import { Interior3D, Street3D } from "./scene";
import { CAN_3D, onKeys } from "./web";

const KEYS: Record<string, Move> = {
  ArrowUp: "forward",
  w: "forward",
  ArrowDown: "back",
  s: "back",
  ArrowLeft: "turnLeft",
  a: "turnLeft",
  ArrowRight: "turnRight",
  d: "turnRight",
  q: "prevStreet",
  "[": "prevStreet",
  e: "nextStreet",
  "]": "nextStreet",
};

/** Where the walker stands, its street held by key. */
interface Walker {
  readonly key: string | null;
  readonly slot: number;
  readonly yaw: number;
}

function cameraOf(walker: Walker, streets: readonly Street[]): Camera {
  const street = streets.findIndex((candidate) => candidate.key === walker.key);
  if (street >= 0) return { street, slot: walker.slot, yaw: walker.yaw };
  return { ...ENTRANCE, street: 0 };
}

/** Degrees of turn per pixel dragged. */
const DRAG = 0.25;

function Chip({
  theme,
  label,
  active = false,
  testID,
  onPress,
}: {
  theme: Theme;
  label: string;
  active?: boolean;
  testID: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={{
        minWidth: 36,
        height: 34,
        paddingHorizontal: 10,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text
        style={{
          color: active ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Card({ theme, style, children }: { theme: Theme; style: object; children: ReactNode }) {
  return (
    <View
      style={[
        {
          position: "absolute",
          padding: 12,
          gap: 4,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

function StoreName({ name, theme, prefix }: { name: string; theme: Theme; prefix: string }) {
  return (
    <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: 12 }}>
      {prefix} {name}
    </Text>
  );
}

/** Paseo as a city: walk the streets in 3D or read the map in 2D. */
export function StreetView({ theme, layout, navigation }: PluginScreenProps) {
  const { streets, loading, error } = useCity();
  const [mode, setMode] = useState<"3d" | "2d">(CAN_3D ? "3d" : "2d");
  // The walker remembers its street and the store it is in by id: a new workspace or project
  // reorders the city under it, and positions alone would then point at someone else's store.
  const [walker, setWalkerState] = useState<Walker>({
    key: null,
    slot: ENTRANCE.slot,
    yaw: ENTRANCE.yaw,
  });
  const [insideId, setInsideId] = useState<string | null>(null);
  const [roomYaw, setRoomYaw] = useState(0);
  const [drag, setDrag] = useState(0);
  // Key repeat fires faster than React renders: every move starts from the last move, not the last render.
  const latest = useRef(walker);
  const city = useRef(streets);
  useEffect(() => {
    city.current = streets;
  }, [streets]);
  const setWalker = useCallback((next: Camera) => {
    latest.current = {
      key: city.current[next.street]?.key ?? null,
      slot: next.slot,
      yaw: next.yaw,
    };
    setWalkerState(latest.current);
  }, []);

  const counts = useMemo(() => streets.map((street) => street.stores.length), [streets]);
  const camera = cameraOf(walker, streets);
  const street = streets[camera.street];
  const store = street?.stores.find((candidate) => candidate.id === insideId) ?? null;
  const inside = store?.id ?? null;
  const faced = street
    ? storeFaced({ ...camera, yaw: camera.yaw + drag }, street.stores.length)
    : null;
  const in3d = CAN_3D && mode === "3d";

  const openAgent = useCallback(
    (session: Session) => navigation?.openAgent({ agentId: session.id }),
    [navigation],
  );
  const enter = useCallback(
    (index: number, streetIndex?: number) => {
      const at = streetIndex ?? cameraOf(latest.current, city.current).street;
      setWalker(cameraAt(at, index));
      setInsideId(city.current[at]?.stores[index]?.id ?? null);
      setRoomYaw(0);
    },
    [setWalker],
  );
  const exit = useCallback(() => setInsideId(null), []);
  const move = useCallback(
    (direction: Move) => {
      if (inside !== null) {
        if (direction === "turnLeft" || direction === "turnRight")
          setRoomYaw((yaw) => yaw + (direction === "turnLeft" ? -45 : 45));
        if (direction === "back") exit();
        return;
      }
      const next = step(cameraOf(latest.current, city.current), direction, counts);
      if (next.kind === "enter") enter(next.store);
      else setWalker(next.camera);
    },
    [counts, enter, exit, inside, setWalker],
  );

  const onKey = useCallback(
    (key: string) => {
      if (key === "m" || key === "M") {
        if (CAN_3D) setMode((current) => (current === "3d" ? "2d" : "3d"));
        return CAN_3D;
      }
      if (key === "Escape") {
        if (inside === null) return false;
        exit();
        return true;
      }
      if (!in3d) return false;
      if (key === "Enter" && inside === null && faced !== null) {
        enter(faced);
        return true;
      }
      const direction = KEYS[key.length === 1 ? key.toLowerCase() : key];
      if (!direction) return false;
      move(direction);
      return true;
    },
    [enter, exit, faced, in3d, inside, move],
  );
  useEffect(() => onKeys(onKey), [onKey]);

  // Drag to look around, as in a street view: pulling the scene left turns the eye right.
  const look = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 6,
        onPanResponderMove: (_, gesture) => setDrag(-gesture.dx * DRAG),
        onPanResponderRelease: (_, gesture) => {
          const turn = -gesture.dx * DRAG;
          setDrag(0);
          if (inside === null) {
            const current = cameraOf(latest.current, city.current);
            setWalker({ ...current, yaw: current.yaw + turn });
          } else setRoomYaw((yaw) => yaw + turn);
        },
        onPanResponderTerminate: () => setDrag(0),
      }),
    [inside, setWalker],
  );

  const surface = { flex: 1, backgroundColor: theme.colors.surface0 };
  if (!street) {
    const message = error
      ? `Could not read the workspaces: ${error}`
      : loading
        ? "Building the city…"
        : "No workspaces yet: the city is empty.";
    return (
      <View
        testID="street-view-empty"
        style={[surface, { alignItems: "center", justifyContent: "center" }]}
      >
        <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
          {message}
        </Text>
      </View>
    );
  }
  const problem = error && (
    <Text testID="street-view-error" style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
      Live updates failed: {error}
    </Text>
  );

  const toggle = CAN_3D && (
    <View style={{ position: "absolute", top: 12, right: 12, flexDirection: "row", gap: 4 }}>
      <Chip
        theme={theme}
        label="2D"
        testID="street-view-mode-2d"
        active={mode === "2d"}
        onPress={() => setMode("2d")}
      />
      <Chip
        theme={theme}
        label="3D"
        testID="street-view-mode-3d"
        active={mode === "3d"}
        onPress={() => setMode("3d")}
      />
    </View>
  );

  if (!in3d) {
    return (
      <View testID="street-view" style={surface}>
        <CityMap
          streets={streets}
          theme={theme}
          camera={camera}
          onStore={(index, at) => enter(at, index)}
        />
        <Card theme={theme} style={{ top: 12, left: 12, right: 120 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
            Paseo city
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {streets.length} streets · {counts.reduce((sum, count) => sum + count, 0)} stores · tap
            a store to look inside
          </Text>
          {problem}
        </Card>
        {store && (
          <StoreDetail
            store={store}
            street={street}
            theme={theme}
            compact={layout.compact}
            onOpen={openAgent}
            onOpenWorkspace={() => navigation?.openWorkspace({ workspaceId: store.id })}
            onWalk={CAN_3D ? () => setMode("3d") : null}
            onClose={exit}
          />
        )}
        {toggle}
      </View>
    );
  }

  return (
    <View testID="street-view" style={surface} {...look.panHandlers}>
      {store ? (
        <Interior3D
          store={store}
          yaw={roomYaw + drag}
          theme={theme}
          animate={drag === 0}
          onOpen={openAgent}
          onExit={exit}
        />
      ) : (
        <Street3D
          key={street.key}
          street={street}
          camera={{ ...camera, yaw: camera.yaw + drag }}
          faced={faced}
          theme={theme}
          animate={drag === 0}
          hasNext={camera.street < streets.length - 1}
          onEnter={enter}
          onOpen={openAgent}
          onNextStreet={() => move("nextStreet")}
        />
      )}
      <Card theme={theme} style={{ top: 12, left: 12, maxWidth: 420 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}
        >
          {street.title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Street {camera.street + 1} of {streets.length} · {street.stores.length} stores
        </Text>
        {store ? (
          <StoreName name={store.name} theme={theme} prefix="Inside" />
        ) : (
          faced !== null &&
          street.stores[faced] && (
            <StoreName name={street.stores[faced].name} theme={theme} prefix="↑ Enter" />
          )
        )}
        {problem}
      </Card>
      {!store && (
        <Card theme={theme} style={{ left: 12, bottom: 12, maxHeight: 220, overflow: "hidden" }}>
          <Pressable
            accessibilityRole="button"
            testID="street-view-minimap"
            onPress={() => setMode("2d")}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Map ⤢</Text>
          </Pressable>
          <StreetColumn
            street={street}
            index={camera.street}
            theme={theme}
            camera={{ ...camera, yaw: camera.yaw + drag }}
            compact
            onStore={(at) => setWalker(cameraAt(camera.street, at))}
          />
        </Card>
      )}
      <View style={{ position: "absolute", right: 12, bottom: 12, alignItems: "flex-end", gap: 6 }}>
        {store ? (
          <Chip
            theme={theme}
            label="Exit to the street"
            testID="street-view-exit-chip"
            onPress={exit}
          />
        ) : (
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Chip
              theme={theme}
              label="‹ Street"
              testID="street-view-prev-street"
              onPress={() => move("prevStreet")}
            />
            <Chip
              theme={theme}
              label="Street ›"
              testID="street-view-next-street-chip"
              onPress={() => move("nextStreet")}
            />
          </View>
        )}
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Chip
            theme={theme}
            label="⟲"
            testID="street-view-turn-left"
            onPress={() => move("turnLeft")}
          />
          {!store && (
            <Chip
              theme={theme}
              label="▲"
              testID="street-view-forward"
              onPress={() => move("forward")}
            />
          )}
          {!store && (
            <Chip theme={theme} label="▼" testID="street-view-back" onPress={() => move("back")} />
          )}
          <Chip
            theme={theme}
            label="⟳"
            testID="street-view-turn-right"
            onPress={() => move("turnRight")}
          />
        </View>
        {!layout.compact && (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            ↑↓ walk · ←→ turn · drag to look · Q/E street · Enter go in · Esc out · M map
          </Text>
        )}
      </View>
      {toggle}
    </View>
  );
}
