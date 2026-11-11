import { describe, expect, test } from "bun:test";
import {
  ENTRANCE,
  ago,
  cameraAt,
  facing,
  lotOf,
  rows,
  buildCity,
  step,
  storeFaced,
  type AgentIn,
  type WorkspaceIn,
} from "./city";

describe("street layout", () => {
  test("stores alternate sides, two per slot", () => {
    expect([0, 1, 2, 3, 4].map(lotOf)).toEqual([
      { side: "left", slot: 0 },
      { side: "right", slot: 0 },
      { side: "left", slot: 1 },
      { side: "right", slot: 1 },
      { side: "left", slot: 2 },
    ]);
    expect(rows(["a", "b", "c"])).toEqual([
      ["a", "b"],
      ["c", undefined],
    ]);
  });
});

describe("building the city", () => {
  const workspace = (
    id: string,
    projectId: string,
    activityAt: string | null,
    extra: Partial<WorkspaceIn> = {},
  ): WorkspaceIn => ({
    id,
    projectId,
    projectDisplayName: `project ${projectId}`,
    name: `ws ${id}`,
    status: "done",
    activityAt,
    ...extra,
  });
  const agent = (
    id: string,
    workspaceId: string,
    updatedAt: string,
    extra: Partial<AgentIn> = {},
  ): AgentIn => ({
    id,
    workspaceId,
    title: `agent ${id}`,
    provider: "claude",
    model: "opus",
    status: "idle",
    updatedAt,
    ...extra,
  });

  test("a street per project; the newest store nearest the entrance, whatever was touched last", () => {
    const city = buildCity(
      [
        workspace("a", "p1", "2026-11-11T00:00:00Z", { createdAt: "2026-11-01T00:00:00Z" }),
        workspace("b", "p2", null, {
          createdAt: "2026-11-10T00:00:00Z",
          status: "needs_input",
          diffStat: { additions: 3, deletions: 1 },
        }),
        workspace("c", "p1", null, { createdAt: "2026-11-05T00:00:00Z" }),
        workspace("hidden", "p1", "2026-11-11T00:00:00Z", { background: true }),
        workspace("going", "p3", "2026-11-11T00:00:00Z", { archivingAt: "2026-11-11T00:00:00Z" }),
      ],
      [],
    );
    expect(
      city.map((street) => [street.key, street.title, street.stores.map((store) => store.id)]),
    ).toEqual([
      ["p2", "project p2", ["b"]],
      ["p1", "project p1", ["c", "a"]],
    ]);
    expect(city[0]?.stores[0]).toMatchObject({ name: "ws b", tone: "attention", diff: "+3 −1" });
  });

  test("a store's sessions: live first, then most recent; archived, internal and loose agents stay out", () => {
    const city = buildCity(
      [workspace("w", "p", "2026-11-10T00:00:00Z")],
      [
        agent("old", "w", "2026-11-01T00:00:00Z"),
        agent("done", "w", "2026-11-11T00:00:00Z", { status: "closed" }),
        agent("new", "w", "2026-11-09T00:00:00Z", { status: "running", title: null, model: null }),
        agent("ask", "w", "2026-11-02T00:00:00Z", {
          requiresAttention: true,
          attentionReason: "permission",
        }),
        agent("gone", "w", "2026-11-11T00:00:00Z", { archivedAt: "2026-11-11T00:00:00Z" }),
        agent("sub", "w", "2026-11-11T00:00:00Z", { internal: true }),
        { ...agent("loose", "w", "2026-11-11T00:00:00Z"), workspaceId: undefined },
      ],
    );
    const sessions = city[0]?.stores[0]?.sessions ?? [];
    expect(sessions.map((session) => [session.id, session.tone])).toEqual([
      ["new", "running"],
      ["ask", "attention"],
      ["old", "idle"],
      ["done", "closed"],
    ]);
    expect(sessions[0]).toMatchObject({ name: "claude", model: "claude" });
  });
});

describe("walking", () => {
  const streets = [3, 0, 2];

  test("forward walks down the street and stops at its last slot", () => {
    let camera = ENTRANCE;
    for (let i = 0; i < 5; i++) {
      const next = step(camera, "forward", streets);
      if (next.kind !== "walk") throw new Error("expected a walk");
      camera = next.camera;
    }
    expect(camera.slot).toBe(1);
    const back = step(camera, "back", streets);
    expect(back).toEqual({ kind: "walk", camera: { ...camera, slot: 0 } });
    const behind = step(ENTRANCE, "back", streets);
    expect(behind).toEqual({ kind: "walk", camera: ENTRANCE });
  });

  test("facing back, forward walks toward the entrance", () => {
    const camera = { street: 0, slot: 1, yaw: 180 };
    expect(step(camera, "forward", streets)).toEqual({
      kind: "walk",
      camera: { ...camera, slot: 0 },
    });
  });

  test("facing a store, forward goes in; facing an empty lot it stays", () => {
    expect(step({ street: 0, slot: 1, yaw: -90 }, "forward", streets)).toEqual({
      kind: "enter",
      store: 2,
    });
    expect(step({ street: 0, slot: 0, yaw: 90 }, "forward", streets)).toEqual({
      kind: "enter",
      store: 1,
    });
    const empty = { street: 0, slot: 1, yaw: 90 };
    expect(step(empty, "forward", streets)).toEqual({ kind: "walk", camera: empty });
  });

  test("turns never wrap yaw, and facing reads it modulo a full turn", () => {
    const turned = step({ ...ENTRANCE, yaw: 315 }, "turnRight", streets);
    expect(turned).toEqual({ kind: "walk", camera: { ...ENTRANCE, yaw: 360 } });
    expect([0, 90, 180, 270, -90, 400].map(facing)).toEqual([
      "ahead",
      "right",
      "back",
      "left",
      "left",
      "ahead",
    ]);
  });

  test("changing street lands at its entrance and stops at the ends", () => {
    const camera = { street: 0, slot: 1, yaw: 90 };
    expect(step(camera, "nextStreet", streets)).toEqual({
      kind: "walk",
      camera: { street: 1, slot: -1, yaw: 0 },
    });
    expect(step(camera, "prevStreet", streets)).toEqual({ kind: "walk", camera });
  });

  test("standing at a store faces it", () => {
    const camera = cameraAt(2, 1);
    expect(camera).toEqual({ street: 2, slot: 0, yaw: 90 });
    expect(storeFaced(camera, streets[2] ?? 0)).toBe(1);
  });
});

test("ago", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  expect(
    [
      "2026-11-11T12:00:30Z",
      "2026-11-11T11:55:00Z",
      "2026-11-11T09:00:00Z",
      "2026-11-08T12:00:00Z",
      "nope",
    ].map((t) => ago(t, now)),
  ).toEqual(["now", "5m", "3h", "3d", "now"]);
});
