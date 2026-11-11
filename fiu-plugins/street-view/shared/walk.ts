/**
 * First-person movement on a street or in a store, in world pixels. `x` runs across (right is +),
 * `d` runs along the street away from its entrance, `yaw` is degrees (0 looks down the street,
 * 90 looks at the right-hand stores) and is never wrapped.
 */
import { lotOf, slotCount } from "./city";

export const LOT = 560;
export const ROAD = 720;
export const ROOM = 1200;
/** How close the walker may get to a wall. */
const MARGIN = 60;
/** Half the width of a store's door, as walked through. */
const DOOR = 80;
export const SPEED = 520;

export interface Pos {
  readonly x: number;
  readonly d: number;
  readonly yaw: number;
}

/** What the walker is pushing: -1..1 forward and right, and degrees turned this frame. */
export interface Drive {
  readonly forward: number;
  readonly strafe: number;
  readonly turn: number;
  readonly sprint: boolean;
}

export type Exit =
  | { readonly kind: "store"; readonly index: number }
  | { readonly kind: "out" }
  | { readonly kind: "nextStreet" }
  | { readonly kind: "prevStreet" };

/** Where the walker may stand, and the openings walking into a wall goes through. */
export interface Arena {
  readonly minX: number;
  readonly maxX: number;
  readonly minD: number;
  readonly maxD: number;
  /** A door in a wall: walking into that wall within `half` of `at` goes through. */
  readonly doors: readonly {
    readonly wall: "left" | "right" | "near" | "far";
    readonly at: number;
    readonly half: number;
    readonly exit: Exit;
  }[];
}

/** A street of `stores`: a door in the middle of every storefront, the next street past the end. */
export function streetArena(stores: number, hasNext: boolean, hasPrev: boolean): Arena {
  const doors: Arena["doors"][number][] = [];
  for (let index = 0; index < stores; index++) {
    const lot = lotOf(index);
    doors.push({
      wall: lot.side,
      at: (lot.slot + 0.5) * LOT,
      half: DOOR,
      exit: { kind: "store", index },
    });
  }
  if (hasNext) doors.push({ wall: "far", at: 0, half: ROAD, exit: { kind: "nextStreet" } });
  if (hasPrev) doors.push({ wall: "near", at: 0, half: ROAD, exit: { kind: "prevStreet" } });
  return {
    minX: -ROAD / 2 + MARGIN,
    maxX: ROAD / 2 - MARGIN,
    minD: -LOT + MARGIN,
    maxD: Math.max(slotCount(stores), 0.5) * LOT + 60,
    doors,
  };
}

/** Inside a store: four walls, the way out in the wall behind where you came in. */
export function roomArena(): Arena {
  const half = ROOM / 2 - MARGIN;
  return {
    minX: -half,
    maxX: half,
    minD: -half,
    maxD: half,
    doors: [{ wall: "near", at: 0, half: 160, exit: { kind: "out" } }],
  };
}

/** Standing in a store's doorway, looking out at the street the way you came in. */
export const ROOM_START: Pos = { x: 0, d: -ROOM / 2 + 200, yaw: 0 };

/**
 * Standing just outside a store, facing it turned by `roomYaw`: leaving with the yaw you had in the
 * room keeps you heading the way you were going, away from the door.
 */
export function outside(index: number, roomYaw = 0): Pos {
  const lot = lotOf(index);
  const left = lot.side === "left";
  return {
    x: left ? -ROAD / 2 + MARGIN + 90 : ROAD / 2 - MARGIN - 90,
    d: (lot.slot + 0.5) * LOT,
    yaw: (left ? -90 : 90) + roomYaw,
  };
}

export const ENTRANCE: Pos = { x: 0, d: -LOT / 2, yaw: 0 };

/** The slot a position is level with: -1 before the first stores. */
export function slotOf(d: number): number {
  return Math.floor(d / LOT);
}

const RADIANS = Math.PI / 180;

/** One frame of walking: move, slide along walls, and report a door walked into. */
export function walk(
  pos: Pos,
  drive: Drive,
  seconds: number,
  arena: Arena,
): { pos: Pos; exit: Exit | null } {
  const yaw = pos.yaw + drive.turn;
  const step = SPEED * (drive.sprint ? 2 : 1) * Math.min(seconds, 0.1);
  const sin = Math.sin(yaw * RADIANS);
  const cos = Math.cos(yaw * RADIANS);
  const wantX = pos.x + (drive.forward * sin + drive.strafe * cos) * step;
  const wantD = pos.d + (drive.forward * cos - drive.strafe * sin) * step;
  const x = clamp(wantX, arena.minX, arena.maxX);
  const d = clamp(wantD, arena.minD, arena.maxD);
  const hit = (wall: Arena["doors"][number]["wall"]) => {
    switch (wall) {
      case "left":
        return wantX < arena.minX;
      case "right":
        return wantX > arena.maxX;
      case "near":
        return wantD < arena.minD;
      case "far":
        return wantD > arena.maxD;
    }
  };
  const along = (wall: Arena["doors"][number]["wall"]) =>
    wall === "left" || wall === "right" ? d : x;
  const door = arena.doors.find(
    (candidate) =>
      hit(candidate.wall) && Math.abs(along(candidate.wall) - candidate.at) <= candidate.half,
  );
  return { pos: { x, d, yaw }, exit: door?.exit ?? null };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface Bug {
  readonly id: string;
  readonly x: number;
  readonly d: number;
  readonly hp: number;
}

export const BUG_HP = 3;
const BUG_SPEED = 140;
/** Bugs stop this far from the walker. */
const BUG_REACH = 170;
/** Bugs notice the walker from this far. */
const BUG_SIGHT = 1400;

/** A street's bugs: one for every three stores, at least two, placed the same way every visit. */
export function spawnBugs(street: string, stores: number): readonly Bug[] {
  let seed = 0;
  for (const char of street) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const count = Math.max(2, Math.ceil(stores / 3));
  const far = streetArena(stores, false, false).maxD;
  return Array.from({ length: count }, (_, i) => ({
    id: `${street}-${i}`,
    x: (random() - 0.5) * (ROAD - 2 * MARGIN),
    d: LOT * 0.6 + random() * (far - LOT * 0.6),
    hp: BUG_HP,
  }));
}

/** A live bug that has seen the walker crawls toward them, and stops at arm's length. */
export function chase(bug: Bug, pos: Pos, seconds: number): Bug {
  const dx = pos.x - bug.x;
  const dd = pos.d - bug.d;
  const distance = Math.hypot(dx, dd);
  if (bug.hp <= 0 || distance > BUG_SIGHT || distance <= BUG_REACH) return bug;
  const step = Math.min(BUG_SPEED * Math.min(seconds, 0.1), distance - BUG_REACH);
  return { ...bug, x: bug.x + (dx / distance) * step, d: bug.d + (dd / distance) * step };
}
