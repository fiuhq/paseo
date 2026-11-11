import { describe, expect, test } from "bun:test";
import {
  BUG_HP,
  ENTRANCE,
  LOT,
  ROAD,
  ROOM_START,
  chase,
  outside,
  roomArena,
  slotOf,
  spawnBugs,
  streetArena,
  walk,
  type Drive,
} from "./walk";

const still: Drive = { forward: 0, strafe: 0, turn: 0, sprint: false };
const second = 1 / 10; // walk() caps a frame at 100 ms, so a "second" is ten frames

function hold(drive: Drive, frames: number, arena = streetArena(4, true, false), from = ENTRANCE) {
  let pos = from;
  for (let i = 0; i < frames; i++) {
    const next = walk(pos, drive, second, arena);
    if (next.exit) return { pos: next.pos, exit: next.exit };
    pos = next.pos;
  }
  return { pos, exit: null };
}

describe("walking", () => {
  test("forward walks down the street, a strafe slides across it, and both follow the yaw", () => {
    const ahead = walk(
      ENTRANCE,
      { ...still, forward: 1 },
      second,
      streetArena(4, false, false),
    ).pos;
    expect(ahead.d).toBeCloseTo(ENTRANCE.d + 52);
    expect(ahead.x).toBeCloseTo(0);
    const right = walk(ENTRANCE, { ...still, strafe: 1 }, second, streetArena(4, false, false)).pos;
    expect(right.x).toBeCloseTo(52);
    // Facing the right-hand stores, forward heads for them and a right strafe walks back toward the entrance.
    const facing = { ...ENTRANCE, yaw: 90 };
    expect(
      walk(facing, { ...still, forward: 1 }, second, streetArena(4, false, false)).pos.x,
    ).toBeCloseTo(52);
    expect(
      walk(facing, { ...still, strafe: 1 }, second, streetArena(4, false, false)).pos.d,
    ).toBeCloseTo(ENTRANCE.d - 52);
  });

  test("sprinting doubles the pace, turning never wraps the yaw, and a long frame is capped", () => {
    expect(
      walk(ENTRANCE, { ...still, forward: 1, sprint: true }, second, streetArena(4, false, false))
        .pos.d,
    ).toBeCloseTo(ENTRANCE.d + 104);
    expect(
      walk({ ...ENTRANCE, yaw: 350 }, { ...still, turn: 20 }, second, streetArena(4, false, false))
        .pos.yaw,
    ).toBe(370);
    expect(
      walk(ENTRANCE, { ...still, forward: 1 }, 5, streetArena(4, false, false)).pos.d,
    ).toBeCloseTo(ENTRANCE.d + 52);
  });

  test("walls stop the walker, who slides along them", () => {
    const { pos, exit } = hold(
      { ...still, strafe: -1, forward: 0.2 },
      40,
      streetArena(0, false, false),
    );
    expect(exit).toBeNull();
    expect(pos.x).toBeCloseTo(-ROAD / 2 + 60);
    expect(pos.d).toBeGreaterThan(ENTRANCE.d);
  });

  test("walking into a store's door goes in; into its wall beside the door does not", () => {
    // Store 0 is the left-hand store of slot 0; its door is level with the middle of the slot.
    const atDoor = { x: 0, d: LOT / 2, yaw: -90 };
    expect(hold({ ...still, forward: 1 }, 20, streetArena(4, false, false), atDoor).exit).toEqual({
      kind: "store",
      index: 0,
    });
    const besideDoor = { x: 0, d: LOT / 2 + 150, yaw: -90 };
    expect(
      hold({ ...still, forward: 1 }, 20, streetArena(4, false, false), besideDoor).exit,
    ).toBeNull();
    // The right-hand side of slot 1 is store 3.
    expect(
      hold({ ...still, forward: 1 }, 20, streetArena(4, false, false), {
        x: 0,
        d: LOT * 1.5,
        yaw: 90,
      }).exit,
    ).toEqual({ kind: "store", index: 3 });
    // No store 3 on a three-store street: the wall is just a wall.
    expect(
      hold({ ...still, forward: 1 }, 20, streetArena(3, false, false), {
        x: 0,
        d: LOT * 1.5,
        yaw: 90,
      }).exit,
    ).toBeNull();
  });

  test("the end of the street leads to the next street, the entrance back to the previous one", () => {
    expect(hold({ ...still, forward: 1 }, 200, streetArena(4, true, true)).exit).toEqual({
      kind: "nextStreet",
    });
    expect(hold({ ...still, forward: -1 }, 200, streetArena(4, true, true)).exit).toEqual({
      kind: "prevStreet",
    });
    expect(hold({ ...still, forward: 1 }, 200, streetArena(4, false, false)).exit).toBeNull();
  });

  test("in a store, walking back out through the door you came in by leaves it", () => {
    expect(hold({ ...still, forward: -1 }, 40, roomArena(), ROOM_START).exit).toEqual({
      kind: "out",
    });
    expect(hold({ ...still, forward: 1 }, 40, roomArena(), ROOM_START).exit).toBeNull();
  });

  test("standing outside a store faces it, level with its door", () => {
    expect(outside(0)).toMatchObject({ d: LOT / 2, yaw: -90 });
    expect(outside(3)).toMatchObject({ d: LOT * 1.5, yaw: 90 });
    expect(
      hold({ ...still, forward: 1 }, 20, streetArena(4, false, false), outside(3)).exit,
    ).toEqual({ kind: "store", index: 3 });
    expect([slotOf(-1), slotOf(0), slotOf(LOT * 1.5)]).toEqual([-1, 0, 1]);
  });
});

describe("bugs", () => {
  test("a street always gets the same bugs, one per three stores and at least two, on the road", () => {
    expect(spawnBugs("core", 9)).toEqual(spawnBugs("core", 9));
    expect(spawnBugs("core", 9)).toHaveLength(3);
    expect(spawnBugs("core", 1)).toHaveLength(2);
    for (const bug of spawnBugs("core", 30)) {
      expect(Math.abs(bug.x)).toBeLessThanOrEqual(ROAD / 2 - 60);
      expect(bug.hp).toBe(BUG_HP);
    }
  });

  test("a bug crawls toward a walker it can see, stops at arm's length, and a dead one stays put", () => {
    const bug = { id: "b", x: 0, d: 1000, hp: BUG_HP };
    const walker = { x: 0, d: 0, yaw: 0 };
    expect(chase(bug, walker, second).d).toBeCloseTo(986);
    let near = bug;
    for (let i = 0; i < 200; i++) near = chase(near, walker, second);
    expect(near.d).toBeCloseTo(170);
    expect(chase({ ...bug, hp: 0 }, walker, second)).toEqual({ ...bug, hp: 0 });
    expect(chase({ ...bug, d: 5000 }, walker, second).d).toBe(5000);
  });
});
