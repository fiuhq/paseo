import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { lotOf, sessionCount, slotCount, type Street } from "../shared/city";
import {
  ENTRANCE,
  LOT,
  ROOM_START,
  SPEED,
  chase,
  outside,
  roomArena,
  slotOf,
  spawnBugs,
  streetArena,
  walk,
  type Bug,
  type Exit,
  type Pos,
} from "../shared/walk";
import { useCity, type Theme } from "./city-data";
import { Crosshair, Gun } from "./gun";
import { CityMap, StoreDetail, StreetColumn } from "./map";
import { Interior3D, Street3D, bugTransform, eyeTransform } from "./scene";
import { CAN_3D, aimed, bang, controls, everyFrame, setStyle, type Controls } from "./web";

/** Degrees per second the arrow keys turn. */
const TURN_RATE = 140;
/** How often the HUD, minimap and haze catch up with the walker. */
const HUD_MS = 120;

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

/** What the crosshair rests on, from the street element's test id. */
type Aim =
  | { readonly kind: "bug"; readonly id: string }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "store"; readonly id: string }
  | { readonly kind: "nextStreet" }
  | { readonly kind: "exit" }
  | null;

function aimOf(testId: string | null): Aim {
  if (!testId) return null;
  const tail = (prefix: string) => (testId.startsWith(prefix) ? testId.slice(prefix.length) : null);
  const bug = tail("street-view-bug-");
  if (bug) return { kind: "bug", id: bug };
  const session = tail("street-view-window-") ?? tail("street-view-card-");
  if (session) return { kind: "session", id: session };
  const store = tail("street-view-door-") ?? tail("street-view-facade-");
  if (store) return { kind: "store", id: store };
  if (testId === "street-view-next-street") return { kind: "nextStreet" };
  if (testId === "street-view-exit") return { kind: "exit" };
  return null;
}

/** How far Space reaches, along the street: the store beside you, not one down the road. */
const REACH = LOT;

/** Whether an aim is within arm's reach of a walker on `street` (inside a store everything is). */
function within(aim: Aim, pos: Pos, street: Street, inside: boolean): boolean {
  if (!aim || aim.kind === "bug" || inside) return aim !== null;
  if (aim.kind === "nextStreet") return pos.d > slotCount(street.stores.length) * LOT - REACH;
  if (aim.kind === "exit") return false;
  const index = street.stores.findIndex(
    (candidate) =>
      candidate.id === aim.id || candidate.sessions.some((session) => session.id === aim.id),
  );
  return index >= 0 && Math.abs(pos.d - (lotOf(index).slot + 0.5) * LOT) < REACH;
}

/** Paseo as a city: walk the streets in 3D, shooting bugs, or read the map in 2D. */
export function StreetView({ theme, layout, navigation }: PluginScreenProps) {
  const { streets, loading, error } = useCity();
  const [mode, setMode] = useState<"3d" | "2d">(CAN_3D ? "3d" : "2d");
  // The street and the store the walker is in are held by id: a new workspace or project
  // reorders the city under it, and positions alone would then point at someone else's store.
  const [streetKey, setStreetKey] = useState<string | null>(null);
  const [insideId, setInsideId] = useState<string | null>(null);
  const [hud, setHud] = useState<{ slot: number; yaw: number; aim: Aim }>({
    slot: -1,
    yaw: 0,
    aim: null,
  });
  const [cracked, setCracked] = useState<ReadonlySet<string>>(() => new Set());
  const [bugVersion, setBugVersion] = useState(0);
  const [locked, setLocked] = useState(false);

  // Everything the frame loop reads and writes lives in refs: a render per frame would be too slow.
  const root = useRef<View>(null);
  const world = useRef<View>(null);
  const gun = useRef<View>(null);
  const flash = useRef<View>(null);
  const mark = useRef<View>(null);
  const pos = useRef<Pos>(ENTRANCE);
  const recoil = useRef(0);
  const bob = useRef(0);
  const bugs = useRef(new Map<string, Bug[]>());
  const bugNodes = useRef(new Map<string, unknown>());
  const input = useRef<Controls | null>(null);

  const streetIndex = Math.max(
    0,
    streets.findIndex((candidate) => candidate.key === streetKey),
  );
  const street: Street | undefined = streets[streetIndex];
  const store = street?.stores.find((candidate) => candidate.id === insideId) ?? null;
  const in3d = CAN_3D && mode === "3d";
  const counts = useMemo(() => streets.map((candidate) => candidate.stores.length), [streets]);

  const streetBugs = useCallback((target: Street): Bug[] => {
    let list = bugs.current.get(target.key);
    if (!list) {
      list = [...spawnBugs(target.key, target.stores.length)];
      bugs.current.set(target.key, list);
    }
    return list;
  }, []);

  // The loop reads the latest render's values through this ref instead of restarting each render.
  const now = useRef({ streets, street, streetIndex, store, in3d });
  now.current = { streets, street, streetIndex, store, in3d };

  const openSession = useCallback(
    (session: { readonly id: string }) => {
      input.current?.release();
      navigation?.openAgent({ agentId: session.id });
    },
    [navigation],
  );
  const enter = useCallback((index: number, at?: number) => {
    const target = now.current.streets[at ?? now.current.streetIndex];
    const id = target?.stores[index]?.id;
    if (!target || !id) return;
    setStreetKey(target.key);
    setInsideId(id);
    pos.current = ROOM_START;
  }, []);
  const exit = useCallback(() => {
    const { street: here, store: inside } = now.current;
    const index =
      here && inside ? here.stores.findIndex((candidate) => candidate.id === inside.id) : -1;
    if (index >= 0) pos.current = outside(index);
    setInsideId(null);
  }, []);
  const changeStreet = useCallback((by: 1 | -1) => {
    const { streets: all, streetIndex: index } = now.current;
    const target = all[index + by];
    if (!target) return;
    setStreetKey(target.key);
    setInsideId(null);
    pos.current =
      by === 1
        ? ENTRANCE
        : { x: 0, d: Math.max(slotCount(target.stores.length), 0.5) * LOT - 80, yaw: 180 };
  }, []);
  const onExit = useCallback(
    (through: Exit) => {
      switch (through.kind) {
        case "store":
          return enter(through.index);
        case "out":
          return exit();
        case "nextStreet":
          return changeStreet(1);
        case "prevStreet":
          return changeStreet(-1);
      }
    },
    [changeStreet, enter, exit],
  );

  const hitMark = useCallback(() => {
    setStyle(mark.current, "transform", "rotate(45deg) scale(1.8)");
    setTimeout(() => setStyle(mark.current, "transform", "none"), 110);
  }, []);
  const fire = useCallback(() => {
    if (!now.current.in3d) return;
    bang();
    recoil.current = 1;
    const aim = aimOf(aimed(root, "street-view-"));
    const here = now.current.street;
    if (aim?.kind === "bug" && here) {
      const list = streetBugs(here);
      const index = list.findIndex((bug) => bug.id === aim.id);
      const bug = list[index];
      if (bug && bug.hp > 0) {
        list[index] = { ...bug, hp: bug.hp - 1 };
        setBugVersion((value) => value + 1);
        hitMark();
      }
    } else if (aim?.kind === "session") {
      setCracked((current) => new Set(current).add(aim.id));
      hitMark();
    }
  }, [hitMark, streetBugs]);
  const use = useCallback(() => {
    if (!now.current.in3d) return;
    const here = now.current.street;
    const seen = aimOf(aimed(root, "street-view-"));
    const aim = here && within(seen, pos.current, here, now.current.store !== null) ? seen : null;
    if (aim?.kind === "session") openSession(aim);
    else if (aim?.kind === "store" && here)
      enter(here.stores.findIndex((candidate) => candidate.id === aim.id));
    else if (aim?.kind === "nextStreet") changeStreet(1);
    else if (aim?.kind === "exit") exit();
  }, [changeStreet, enter, exit, openSession]);

  const onKey = useCallback(
    (key: string) => {
      if (key === "m" || key === "M") {
        input.current?.release();
        setMode((current) => (current === "3d" ? "2d" : "3d"));
        return true;
      }
      if (key === "[" || key === "]") {
        changeStreet(key === "]" ? 1 : -1);
        return true;
      }
      if (key === "Escape" && now.current.store) {
        exit();
        return true;
      }
      return false;
    },
    [changeStreet, exit],
  );

  // Input and the frame loop live as long as the screen; they read everything else through refs.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const handlers = useRef({ fire, use, onKey });
  handlers.current = { fire, use, onKey };
  useEffect(() => {
    const live = controls(root, {
      onFire: () => handlers.current.fire(),
      onUse: () => handlers.current.use(),
      onKey: (key) => handlers.current.onKey(key),
      onLockChange: setLocked,
    });
    input.current = live;
    let sinceHud = 0;
    const stop = everyFrame((seconds) => {
      const {
        street: here,
        store: inside,
        streetIndex: index,
        streets: all,
        in3d: playing,
      } = now.current;
      if (!playing || !here) return;
      const held = live.held;
      const key = (name: string) => (held.has(name) ? 1 : 0);
      const swipe = live.take();
      const sprint = held.has("shift");
      const frame = SPEED * Math.min(seconds, 0.1) * (sprint ? 2 : 1);
      const forward =
        key("w") +
        key("arrowup") -
        key("s") -
        key("arrowdown") +
        (frame > 0 ? swipe.walk / frame : 0);
      const strafe = key("d") - key("a");
      const turn = (key("arrowright") - key("arrowleft")) * TURN_RATE * seconds + swipe.turn;
      const arena = inside
        ? roomArena()
        : streetArena(here.stores.length, index < all.length - 1, index > 0);
      const step = walk(pos.current, { forward, strafe, turn, sprint }, seconds, arena);
      pos.current = step.pos;
      setStyle(world.current, "transform", eyeTransform(step.pos));

      if (!inside) {
        const list = streetBugs(here);
        for (let i = 0; i < list.length; i++) {
          const bug = list[i];
          if (!bug) continue;
          const moved = chase(bug, step.pos, seconds);
          list[i] = moved;
          setStyle(bugNodes.current.get(moved.id), "transform", bugTransform(moved, step.pos.yaw));
        }
      }

      const moving = forward !== 0 || strafe !== 0;
      if (moving) bob.current += seconds * (sprint ? 14 : 9);
      recoil.current = Math.max(0, recoil.current - seconds * 4);
      const sway = moving ? Math.sin(bob.current) * 10 : 0;
      setStyle(
        gun.current,
        "transform",
        `translate(${sway}px, ${Math.abs(sway) + recoil.current * 70}px) rotate(${-recoil.current * 6}deg)`,
      );
      setStyle(flash.current, "opacity", recoil.current > 0.75 ? "1" : "0");

      sinceHud += seconds * 1000;
      if (sinceHud >= HUD_MS) {
        sinceHud = 0;
        const seen = aimOf(aimed(root, "street-view-"));
        const aim =
          seen?.kind === "bug" || within(seen, step.pos, here, inside !== null) ? seen : null;
        setHud((current) =>
          current.slot === slotOf(step.pos.d) &&
          Math.round(current.yaw) === Math.round(step.pos.yaw) &&
          JSON.stringify(current.aim) === JSON.stringify(aim)
            ? current
            : { slot: slotOf(step.pos.d), yaw: step.pos.yaw, aim },
        );
      }
      if (step.exit) onExitRef.current(step.exit);
    });
    return () => {
      stop();
      live.dispose();
      input.current = null;
    };
  }, [streetBugs]);

  // Put the eye in place before the first paint of a street or a room, not one frame later.
  useLayoutEffect(() => {
    setStyle(world.current, "transform", eyeTransform(pos.current));
  }, [streetKey, insideId, mode]);

  const registerBug = useCallback((id: string, node: unknown) => {
    if (node) bugNodes.current.set(id, node);
    else bugNodes.current.delete(id);
  }, []);
  const bugList = useMemo(
    () => (street ? streetBugs(street).map((bug) => ({ id: bug.id, hp: bug.hp })) : []),
    // bugVersion: the list mutates in place when a bug is hit.
    [street, streetBugs, bugVersion],
  );

  const surface = { flex: 1, backgroundColor: theme.colors.surface0 };
  if (!street) {
    const message = error
      ? `Could not load everything: ${error}`
      : loading
        ? "Building the city…"
        : "No workspaces yet: the city is empty.";
    return (
      <View
        ref={root}
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
      Could not load everything: {error}
    </Text>
  );
  const camera = { street: streetIndex, slot: hud.slot, yaw: hud.yaw };
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
      <View ref={root} testID="street-view" style={surface}>
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
            onOpen={openSession}
            onOpenWorkspace={() => navigation?.openWorkspace({ workspaceId: store.id })}
            onWalk={CAN_3D ? () => setMode("3d") : null}
            onClose={exit}
          />
        )}
        {toggle}
      </View>
    );
  }

  const names = new Map<string, string>();
  for (const candidate of street.stores) {
    names.set(candidate.id, candidate.name);
    for (const session of candidate.sessions) names.set(session.id, session.name);
  }
  const aim = hud.aim;
  const hint =
    aim?.kind === "bug"
      ? "Click or F: shoot the bug"
      : aim?.kind === "session"
        ? `Space: open ${names.get(aim.id) ?? "this session"} · click: shoot the window`
        : aim?.kind === "store"
          ? `Space or walk in: enter ${names.get(aim.id) ?? "this store"}`
          : aim?.kind === "nextStreet"
            ? "Space: next street"
            : aim?.kind === "exit"
              ? "Space: back to the street"
              : null;
  const squashed = bugList.filter((bug) => bug.hp <= 0).length;

  return (
    <View ref={root} testID="street-view" style={surface}>
      {store ? (
        <Interior3D store={store} world={world} theme={theme} onOpen={openSession} onExit={exit} />
      ) : (
        <Street3D
          key={street.key}
          street={street}
          world={world}
          slot={hud.slot}
          faced={
            aim?.kind === "store"
              ? street.stores.findIndex((candidate) => candidate.id === aim.id)
              : null
          }
          theme={theme}
          cracked={cracked}
          bugs={bugList}
          register={registerBug}
          hasNext={streetIndex < streets.length - 1}
          onEnter={enter}
          onOpen={openSession}
          onNextStreet={() => changeStreet(1)}
        />
      )}
      <Gun theme={theme} gun={gun} flash={flash} />
      <Crosshair theme={theme} mark={mark} />
      <Card theme={theme} style={{ top: 12, left: 12, maxWidth: 440 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}
        >
          {store ? store.name : street.title}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {store
            ? `Inside · ${sessionCount(store.sessions.length)} · walk back out the way you came`
            : `Street ${streetIndex + 1} of ${streets.length} · ${street.stores.length} stores · 👾 ${squashed}/${bugList.length} squashed`}
        </Text>
        {hint && (
          <Text
            testID="street-view-hint"
            numberOfLines={1}
            style={{ color: theme.colors.accent, fontSize: 12 }}
          >
            {hint}
          </Text>
        )}
        {problem}
      </Card>
      {!locked && (
        <View
          style={{ position: "absolute", top: 12, left: 0, right: 0, alignItems: "center" }}
          pointerEvents="box-none"
        >
          <Pressable
            accessibilityRole="button"
            testID="street-view-play"
            onPress={() => input.current?.capture()}
            style={{
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" }}>
              🎮 Click to play: your finger looks around, a click shoots, Esc lets go
            </Text>
          </Pressable>
        </View>
      )}
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
            index={streetIndex}
            theme={theme}
            camera={camera}
            compact
            onStore={(at) => {
              pos.current = outside(at);
            }}
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
              onPress={() => changeStreet(-1)}
            />
            <Chip
              theme={theme}
              label="Street ›"
              testID="street-view-next-street-chip"
              onPress={() => changeStreet(1)}
            />
          </View>
        )}
        {!layout.compact && (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            WASD walk · Shift run · two-finger swipe: walk and turn · ←→ turn · click shoots · Space
            opens · [ ] street · M map
          </Text>
        )}
      </View>
      {toggle}
    </View>
  );
}
