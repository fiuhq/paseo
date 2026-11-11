/** A city of Paseo work: a project is a street, a workspace a store on it, an agent a window in it. */

export type Tone = "running" | "attention" | "failed" | "idle" | "closed";

/** One colour per agent state, attention first: an agent waiting on you matters more than one working. */
export function agentTone(agent: {
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
}): Tone {
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.requiresAttention) return "attention";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.status === "closed") return "closed";
  return "idle";
}

export function workspaceTone(
  indicator: "needs_input" | "failed" | "running" | "attention" | "done",
): Tone {
  switch (indicator) {
    case "needs_input":
    case "attention":
      return "attention";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "done":
      return "idle";
  }
}

/** A workspace as the daemon lists it: only the fields the city reads. */
export interface WorkspaceIn {
  readonly id: string;
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly name: string;
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly activityAt: string | null;
  readonly createdAt?: string;
  readonly background?: boolean;
  readonly archivingAt?: string | null;
  readonly diffStat?: { readonly additions: number; readonly deletions: number } | null;
}

/** An agent as the daemon lists it: only the fields the city reads. */
export interface AgentIn {
  readonly id: string;
  readonly workspaceId?: string;
  readonly title: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly requiresAttention?: boolean;
  readonly attentionReason?: "finished" | "error" | "permission" | null;
  readonly updatedAt: string;
  readonly archivedAt?: string | null;
  readonly internal?: boolean;
}

export interface Session {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly status: AgentIn["status"];
  readonly tone: Tone;
  readonly updatedAt: string;
}

export interface Store {
  readonly id: string;
  readonly name: string;
  readonly tone: Tone;
  readonly diff: string | null;
  readonly sessions: readonly Session[];
}

export interface Street {
  readonly key: string;
  readonly title: string;
  readonly stores: readonly Store[];
}

/**
 * A street per project; its live workspaces as stores, newest nearest the entrance; each store's
 * sessions live first, then most recently active. Stores never move when agents work: the order
 * is by creation, so only a new workspace changes the map.
 */
export function buildCity(
  workspaces: Iterable<WorkspaceIn>,
  agents: Iterable<AgentIn>,
): readonly Street[] {
  const sessions = new Map<string, (Session & { readonly closed: boolean })[]>();
  for (const agent of agents) {
    if (!agent.workspaceId || agent.archivedAt || agent.internal) continue;
    const list = sessions.get(agent.workspaceId) ?? [];
    list.push({
      id: agent.id,
      name: agent.title ?? agent.provider,
      model: agent.model ?? agent.provider,
      status: agent.status,
      tone: agentTone({
        status: agent.status,
        requiresAttention: agent.requiresAttention ?? false,
        attentionReason: agent.attentionReason ?? null,
      }),
      updatedAt: agent.updatedAt,
      closed: agent.status === "closed",
    });
    sessions.set(agent.workspaceId, list);
  }
  const live = [...workspaces].filter(
    (workspace) => !workspace.background && !workspace.archivingAt,
  );
  live.sort(
    (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id),
  );
  const streets = new Map<string, { key: string; title: string; stores: Store[] }>();
  for (const workspace of live) {
    const street = streets.get(workspace.projectId) ?? {
      key: workspace.projectId,
      title: workspace.projectDisplayName,
      stores: [],
    };
    const inside = (sessions.get(workspace.id) ?? []).sort(
      (a, b) => Number(a.closed) - Number(b.closed) || b.updatedAt.localeCompare(a.updatedAt),
    );
    street.stores.push({
      id: workspace.id,
      name: workspace.name,
      tone: workspaceTone(workspace.status),
      diff: workspace.diffStat
        ? `+${workspace.diffStat.additions} −${workspace.diffStat.deletions}`
        : null,
      sessions: inside.map(({ closed: _closed, ...session }) => session),
    });
    streets.set(workspace.projectId, street);
  }
  return [...streets.values()];
}

export type Side = "left" | "right";

/** Stores alternate sides of the street; two stores face each other across one slot. */
export function lotOf(index: number): { readonly side: Side; readonly slot: number } {
  return { side: index % 2 === 0 ? "left" : "right", slot: Math.floor(index / 2) };
}

export function slotCount(stores: number): number {
  return Math.ceil(stores / 2);
}

/** Pairs a street's stores into the rows a top-down map draws: left store, road, right store. */
export function rows<T>(stores: readonly T[]): readonly (readonly [T, T | undefined])[] {
  const out: (readonly [T, T | undefined])[] = [];
  stores.forEach((store, i) => {
    if (i % 2 === 0) out.push([store, stores[i + 1]]);
  });
  return out;
}

/**
 * Where the walker stands: a street, a slot along it (-1 is the entrance), and a yaw in degrees
 * (0 looks down the street, 90 looks at the right-hand stores). Yaw is never wrapped, so a turn
 * always animates the short way.
 */
export interface Camera {
  readonly street: number;
  readonly slot: number;
  readonly yaw: number;
}

export const ENTRANCE: Camera = { street: 0, slot: -1, yaw: 0 };

export type Facing = "ahead" | "right" | "back" | "left";

export function facing(yaw: number): Facing {
  const a = ((yaw % 360) + 360) % 360;
  if (a < 45 || a >= 315) return "ahead";
  if (a < 135) return "right";
  if (a < 225) return "back";
  return "left";
}

/** The store index the walker is looking straight at, if any. */
export function storeFaced(camera: Camera, stores: number): number | null {
  const side = facing(camera.yaw);
  if ((side !== "left" && side !== "right") || camera.slot < 0) return null;
  const index = camera.slot * 2 + (side === "left" ? 0 : 1);
  return index < stores ? index : null;
}

/** Stand in front of a store, facing it. */
export function cameraAt(street: number, index: number): Camera {
  const lot = lotOf(index);
  return { street, slot: lot.slot, yaw: lot.side === "left" ? -90 : 90 };
}

export type Move = "forward" | "back" | "turnLeft" | "turnRight" | "nextStreet" | "prevStreet";

export type Step =
  | { readonly kind: "walk"; readonly camera: Camera }
  | { readonly kind: "enter"; readonly store: number };

const TURN = 45;

/**
 * One key press. Forward walks the way the walker faces along the street; facing a store,
 * forward goes in. `streets` holds each street's store count.
 */
export function step(camera: Camera, move: Move, streets: readonly number[]): Step {
  const stores = streets[camera.street] ?? 0;
  switch (move) {
    case "turnLeft":
      return { kind: "walk", camera: { ...camera, yaw: camera.yaw - TURN } };
    case "turnRight":
      return { kind: "walk", camera: { ...camera, yaw: camera.yaw + TURN } };
    case "nextStreet":
    case "prevStreet": {
      const street = clamp(camera.street + (move === "nextStreet" ? 1 : -1), 0, streets.length - 1);
      return {
        kind: "walk",
        camera: street === camera.street ? camera : { street, slot: -1, yaw: 0 },
      };
    }
    case "forward":
    case "back": {
      const side = facing(camera.yaw);
      if (move === "forward" && (side === "left" || side === "right")) {
        const store = storeFaced(camera, stores);
        return store === null ? { kind: "walk", camera } : { kind: "enter", store };
      }
      const along = (side === "back" ? -1 : 1) * (move === "back" ? -1 : 1);
      const slot = clamp(camera.slot + along, -1, Math.max(slotCount(stores) - 1, -1));
      return { kind: "walk", camera: { ...camera, slot } };
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function sessionCount(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/** "now", "5m", "3h", "2d": how long ago an ISO time was. */
export function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
