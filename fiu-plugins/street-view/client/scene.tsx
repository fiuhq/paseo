import { memo, type ReactNode, type Ref } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ago,
  lotOf,
  sessionCount,
  slotCount,
  type Session,
  type Store,
  type Street,
} from "../shared/city";
import { toneColor, type Theme } from "./city-data";
import { BUG_HP, LOT, ROAD, ROOM, type Pos } from "../shared/walk";
import { plane, space, sprite, viewport } from "./web";

// World units are CSS pixels. Forward along a street is -z; up is -y.
const PERSPECTIVE = 700;
const EYE = 170;
const FACADE_W = 500;
const FACADE_H = 380;
const WINDOWS = 9;

function at(x: number, y: number, z: number, turn = 0, tilt = 0): string {
  return `translate3d(${x}px, ${y}px, ${z}px) rotateY(${turn}deg) rotateX(${tilt}deg)`;
}

/** Puts the eye at a point looking along `yaw`: the world moves the opposite way. */
export function eyeTransform(pos: Pos): string {
  return `translateZ(${PERSPECTIVE}px) rotateY(${pos.yaw}deg) translate3d(${-pos.x}px, ${EYE}px, ${pos.d}px)`;
}

const BUG = 150;

/** Where a bug hovers, at eye level so the crosshair finds it (Doom aims up and down for you), turned to face the eye. */
export function bugTransform(bug: { readonly x: number; readonly d: number }, yaw: number): string {
  return `translate3d(${bug.x}px, ${-EYE}px, ${-bug.d}px) rotateY(${-yaw}deg)`;
}

/** A bug to shoot: the loop places it every frame, so its own style carries no position. */
const BugSprite = memo(function BugSprite({
  id,
  hp,
  register,
}: {
  id: string;
  hp: number;
  register(id: string, node: unknown): void;
}) {
  return (
    <View
      ref={(node) => register(id, node)}
      testID={`street-view-bug-${id}`}
      accessibilityLabel={hp > 0 ? `Bug, ${hp} of ${BUG_HP} health` : "Squashed bug"}
      style={[sprite(BUG, BUG), { opacity: hp > 0 ? 0.55 + (0.45 * hp) / BUG_HP : 0.9 }]}
    >
      <Text style={{ fontSize: hp > 0 ? 110 : 90, lineHeight: 130 }}>{hp > 0 ? "👾" : "💥"}</Text>
    </View>
  );
});

function Viewport({ theme, children }: { theme: Theme; children: ReactNode }) {
  const style = viewport(PERSPECTIVE);
  return <View style={[style, { backgroundColor: theme.colors.surface0 }]}>{children}</View>;
}

function Window({
  session,
  theme,
  cracked,
  onOpen,
}: {
  session: Session;
  theme: Theme;
  cracked: boolean;
  onOpen(session: Session): void;
}) {
  const tone = session.tone;
  const lit = tone !== "idle" && tone !== "closed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open session ${session.name}`}
      testID={`street-view-window-${session.id}`}
      onPress={() => onOpen(session)}
      style={{
        width: 146,
        height: 62,
        padding: 6,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: lit ? toneColor(tone, theme) : theme.colors.foregroundMuted,
        backgroundColor: lit
          ? toneColor(tone, theme)
          : tone === "closed"
            ? theme.colors.border
            : theme.colors.surface0,
      }}
    >
      <Text
        numberOfLines={2}
        style={{
          color: lit ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: 12,
        }}
      >
        {session.name}
      </Text>
      {cracked && (
        <Text
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            textAlign: "center",
            fontSize: 44,
            lineHeight: 58,
            color: theme.colors.foreground,
            opacity: 0.7,
          }}
        >
          ✳
        </Text>
      )}
    </Pressable>
  );
}

/** A workspace as a storefront: its name on the sign, a window per session, a door to walk in. */
const Facade = memo(function Facade({
  store,
  index,
  theme,
  faced,
  fog,
  cracked,
  onEnter,
  onOpen,
}: {
  store: Store;
  index: number;
  theme: Theme;
  faced: boolean;
  fog: number;
  cracked: ReadonlySet<string>;
  onEnter(index: number): void;
  onOpen(session: Session): void;
}) {
  const { sessions, name } = store;
  const lot = lotOf(index);
  const z = -(lot.slot + 0.5) * LOT;
  const left = lot.side === "left";
  const tone = toneColor(store.tone, theme);
  const shown = sessions.slice(0, sessions.length > WINDOWS ? WINDOWS - 1 : WINDOWS);
  return (
    <View
      testID={`street-view-facade-${store.id}`}
      style={[
        plane(
          FACADE_W,
          FACADE_H,
          at(left ? -ROAD / 2 : ROAD / 2, -FACADE_H / 2, z, left ? 90 : -90),
        ),
        {
          opacity: fog,
          borderWidth: faced ? 4 : 2,
          borderColor: faced ? theme.colors.accent : theme.colors.foregroundMuted,
          backgroundColor: theme.colors.surface2,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Enter store ${name}`}
        onPress={() => onEnter(index)}
        style={{
          padding: 12,
          gap: 2,
          borderBottomWidth: 6,
          borderBottomColor: tone,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 26, fontWeight: "800" }}
        >
          {name}
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {[store.diff, sessionCount(sessions.length)].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          flexWrap: "wrap",
          alignContent: "flex-start",
          gap: 8,
          padding: 10,
        }}
      >
        {shown.map((session) => (
          <Window
            key={session.id}
            session={session}
            theme={theme}
            cracked={cracked.has(session.id)}
            onOpen={onOpen}
          />
        ))}
        {sessions.length > shown.length && (
          <View style={{ width: 146, height: 62, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
              +{sessions.length - shown.length} inside
            </Text>
          </View>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Walk into ${name}`}
        testID={`street-view-door-${store.id}`}
        onPress={() => onEnter(index)}
        style={{
          alignSelf: "center",
          width: 96,
          height: 70,
          alignItems: "center",
          justifyContent: "center",
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
          backgroundColor: faced ? theme.colors.accent : theme.colors.surface0,
          borderWidth: 2,
          borderBottomWidth: 0,
          borderColor: theme.colors.foregroundMuted,
        }}
      >
        <Text
          style={{
            color: faced ? theme.colors.accentForeground : theme.colors.foreground,
            fontSize: 14,
            fontWeight: "700",
          }}
        >
          Enter
        </Text>
      </Pressable>
    </View>
  );
});

/** Dashes down the middle of a road plane of `length` px. */
function Road({ length, theme }: { length: number; theme: Theme }) {
  const dashes = Math.floor(length / 160);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "space-around" }}>
      {Array.from({ length: dashes }, (_, i) => (
        <View key={i} style={{ width: 10, height: 70, backgroundColor: theme.colors.surface0 }} />
      ))}
    </View>
  );
}

/** Standing on a street, looking along it. */
export function Street3D({
  street,
  world,
  slot,
  faced,
  theme,
  cracked,
  bugs,
  register,
  hasNext,
  onEnter,
  onOpen,
  onNextStreet,
}: {
  street: Street;
  /** The moving world: the frame loop sets its transform to put the eye where the walker is. */
  world: Ref<View>;
  /** The slot the walker is level with, for the haze on far stores. */
  slot: number;
  faced: number | null;
  theme: Theme;
  cracked: ReadonlySet<string>;
  bugs: readonly { readonly id: string; readonly hp: number }[];
  register(id: string, node: unknown): void;
  hasNext: boolean;
  onEnter(index: number): void;
  onOpen(session: Session): void;
  onNextStreet(): void;
}) {
  const slots = slotCount(street.stores.length);
  const length = (slots + 2) * LOT;
  const end = -(slots * LOT + 120);
  return (
    <Viewport theme={theme}>
      <View ref={world} testID="street-view-3d" style={space()}>
        <View
          style={[
            plane(ROAD, length, at(0, 0, -(slots * LOT) / 2, 0, 90)),
            { backgroundColor: theme.colors.border },
          ]}
        >
          <Road length={length} theme={theme} />
        </View>
        <View
          style={[
            plane(ROAD, 90, at(0, -FACADE_H + 45, -LOT * 0.2)),
            {
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.accent,
              borderRadius: 8,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.accentForeground, fontSize: 34, fontWeight: "800" }}
          >
            {street.title}
          </Text>
        </View>
        {street.stores.map((store, index) => (
          <Facade
            key={store.id}
            store={store}
            index={index}
            theme={theme}
            faced={faced === index}
            fog={Math.max(0.15, Math.min(1, 1 - (Math.abs(lotOf(index).slot - slot) - 3) * 0.2))}
            cracked={cracked}
            onEnter={onEnter}
            onOpen={onOpen}
          />
        ))}
        <View
          style={[
            plane(ROAD, FACADE_H, at(0, -FACADE_H / 2, end)),
            {
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              backgroundColor: theme.colors.surface2,
              borderWidth: 2,
              borderColor: theme.colors.foregroundMuted,
            },
          ]}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 24 }}>
            End of {street.title}
          </Text>
          {hasNext && (
            <Pressable
              accessibilityRole="button"
              testID="street-view-next-street"
              onPress={onNextStreet}
              style={{
                paddingHorizontal: 20,
                paddingVertical: 12,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text
                style={{ color: theme.colors.accentForeground, fontSize: 20, fontWeight: "700" }}
              >
                Next street →
              </Text>
            </Pressable>
          )}
        </View>
        {bugs.map((bug) => (
          <BugSprite key={bug.id} id={bug.id} hp={bug.hp} register={register} />
        ))}
      </View>
    </Viewport>
  );
}

// The room inside a store.
const ROOM_H = 440;
const CARDS_PER_WALL = 6;

function SessionCard({
  session,
  theme,
  onOpen,
}: {
  session: Session;
  theme: Theme;
  onOpen(session: Session): void;
}) {
  const tone = toneColor(session.tone, theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open session ${session.name}`}
      testID={`street-view-card-${session.id}`}
      onPress={() => onOpen(session)}
      style={{
        width: 280,
        height: 150,
        padding: 12,
        gap: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderTopWidth: 6,
        borderColor: theme.colors.border,
        borderTopColor: tone,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Text
        numberOfLines={3}
        style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}
      >
        {session.name}
      </Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {session.model} · {session.status} · {ago(session.updatedAt, Date.now())}
      </Text>
    </Pressable>
  );
}

function Wall({
  transform,
  theme,
  children,
}: {
  transform: string;
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        plane(ROOM, ROOM_H, transform),
        {
          flexDirection: "row",
          flexWrap: "wrap",
          alignContent: "center",
          justifyContent: "center",
          gap: 20,
          padding: 30,
          backgroundColor: theme.colors.surface2,
          borderWidth: 2,
          borderColor: theme.colors.foregroundMuted,
        },
      ]}
    >
      {children}
    </View>
  );
}

/** Inside a store: its sessions hang on the walls; the way out is behind you. */
export function Interior3D({
  store,
  world,
  theme,
  onOpen,
  onExit,
}: {
  store: Store;
  /** The moving world: the frame loop sets its transform to put the eye where the walker is. */
  world: Ref<View>;
  theme: Theme;
  onOpen(session: Session): void;
  onExit(): void;
}) {
  const { sessions, name } = store;
  const half = ROOM / 2;
  const y = -ROOM_H / 2;
  const walls = [at(0, y, -half), at(half, y, 0, -90), at(-half, y, 0, 90)];
  return (
    <Viewport theme={theme}>
      <View ref={world} testID="street-view-interior" style={space()}>
        <View
          style={[plane(ROOM, ROOM, at(0, 0, 0, 0, 90)), { backgroundColor: theme.colors.border }]}
        />
        {walls.map((transform, wall) => {
          const cards = sessions.slice(wall * CARDS_PER_WALL, (wall + 1) * CARDS_PER_WALL);
          const rest =
            wall === walls.length - 1 ? sessions.length - (wall + 1) * CARDS_PER_WALL : 0;
          return (
            <Wall key={wall} transform={transform} theme={theme}>
              {wall === 0 && sessions.length === 0 && (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 22 }}>
                  No sessions in {name}
                </Text>
              )}
              {cards.map((session) => (
                <SessionCard key={session.id} session={session} theme={theme} onOpen={onOpen} />
              ))}
              {rest > 0 && (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>
                  +{rest} more in the workspace
                </Text>
              )}
            </Wall>
          );
        })}
        <Wall transform={at(0, y, half, 180)} theme={theme}>
          <Pressable
            accessibilityRole="button"
            testID="street-view-exit"
            onPress={onExit}
            style={{
              paddingHorizontal: 28,
              paddingVertical: 40,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 22, fontWeight: "700" }}>
              Exit to the street
            </Text>
          </Pressable>
        </Wall>
      </View>
    </Viewport>
  );
}
