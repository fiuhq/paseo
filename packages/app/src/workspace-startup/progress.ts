import type { CreationSnapshot, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { formatDuration } from "@/utils/time";

/**
 * What a new workspace is doing between Enter and its agent's first turn, timed from the daemon's
 * creation phases so the user sees which step is slow instead of a frozen composer.
 */
export interface StartupProgress {
  serverId: string;
  draftId: string;
  /** The provider's display name, e.g. "Claude". */
  agentLabel: string;
  submittedAt: number;
  isWorktree: boolean;
  worktreeSlug: string | null;
  workspaceReadyAt: number | null;
  agentId: string | null;
  agentReadyAt: number | null;
}

export interface StartupWorkspace {
  kind: WorkspaceDescriptorPayload["workspaceKind"];
  worktreeSlug: string | null;
}

export interface StartupEvent {
  phase: CreationSnapshot["phase"];
  at: number;
  workspace?: StartupWorkspace;
  agentId?: string | null;
}

export type StepState = "waiting" | "running" | "done";

export interface StartupStep {
  state: StepState;
  /** Whole duration once done, null until then. */
  seconds: number | null;
  /** When a running step started, for a live clock; null otherwise. */
  since: number | null;
}

export interface StartingView {
  kind: "starting";
  workspace: StartupStep & { isWorktree: boolean; worktreeSlug: string | null };
  agent: StartupStep;
}

export interface ReadyView {
  kind: "ready";
  totalSeconds: number;
  workspaceSeconds: number;
  agentSeconds: number;
  isWorktree: boolean;
}

export type StartupView = StartingView | ReadyView;

const WORKSPACE_READY_PHASES: ReadonlySet<CreationSnapshot["phase"]> = new Set([
  "workspace_ready",
  "agent_ready",
  "prompt_started",
  "completed",
]);
const AGENT_READY_PHASES: ReadonlySet<CreationSnapshot["phase"]> = new Set([
  "agent_ready",
  "prompt_started",
  "completed",
]);

export function beginStartup(input: {
  serverId: string;
  draftId: string;
  agentLabel: string;
  at: number;
  isWorktree: boolean;
}): StartupProgress {
  return {
    serverId: input.serverId,
    draftId: input.draftId,
    agentLabel: input.agentLabel,
    submittedAt: input.at,
    isWorktree: input.isWorktree,
    worktreeSlug: null,
    workspaceReadyAt: null,
    agentId: null,
    agentReadyAt: null,
  };
}

/** Each phase is stamped once, at its first sighting: a re-sent snapshot never moves a step's time. */
export function advanceStartup(progress: StartupProgress, event: StartupEvent): StartupProgress {
  const reachesWorkspace =
    WORKSPACE_READY_PHASES.has(event.phase) && progress.workspaceReadyAt === null;
  const reachesAgent = AGENT_READY_PHASES.has(event.phase) && progress.agentReadyAt === null;
  if (!reachesWorkspace && !reachesAgent) return progress;
  const next = { ...progress };
  if (reachesWorkspace) {
    next.workspaceReadyAt = event.at;
    if (event.workspace) {
      next.isWorktree = event.workspace.kind === "worktree";
      next.worktreeSlug = event.workspace.worktreeSlug;
    }
  }
  if (reachesAgent) {
    next.agentReadyAt = event.at;
    next.agentId = event.agentId ?? null;
  }
  return next;
}

function secondsBetween(from: number, to: number): number {
  return Math.round((to - from) / 100) / 10;
}

export function describeStartup(progress: StartupProgress): StartupView {
  const { submittedAt, workspaceReadyAt, agentReadyAt } = progress;
  if (workspaceReadyAt !== null && agentReadyAt !== null) {
    return {
      kind: "ready",
      totalSeconds: secondsBetween(submittedAt, agentReadyAt),
      workspaceSeconds: secondsBetween(submittedAt, workspaceReadyAt),
      agentSeconds: secondsBetween(workspaceReadyAt, agentReadyAt),
      isWorktree: progress.isWorktree,
    };
  }
  if (workspaceReadyAt === null) {
    return {
      kind: "starting",
      workspace: {
        state: "running",
        seconds: null,
        since: submittedAt,
        isWorktree: progress.isWorktree,
        worktreeSlug: null,
      },
      agent: { state: "waiting", seconds: null, since: null },
    };
  }
  return {
    kind: "starting",
    workspace: {
      state: "done",
      seconds: secondsBetween(submittedAt, workspaceReadyAt),
      since: null,
      isWorktree: progress.isWorktree,
      worktreeSlug: progress.worktreeSlug,
    },
    agent: {
      state: "running",
      seconds: null,
      since: workspaceReadyAt,
    },
  };
}

export function formatSeconds(seconds: number): string {
  if (seconds >= 60) return formatDuration(seconds * 1000);
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}
