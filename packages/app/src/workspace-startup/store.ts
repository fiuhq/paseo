import { create } from "zustand";
import { advanceStartup, type StartupEvent, type StartupProgress } from "./progress";

export interface StartupFailure {
  serverId: string;
  workspaceId: string;
  /** Where the draft went back to: New workspace, for whoever is still on the workspace. */
  returnRoute: string;
  message: string;
}

interface WorkspaceStartupState {
  byDraftId: Record<string, StartupProgress>;
  /** Why the last start failed, shown on New workspace, where its draft went back to. */
  failure: StartupFailure | null;
  begin: (progress: StartupProgress) => void;
  advance: (input: { draftId: string; event: StartupEvent }) => void;
  discard: (input: { draftId: string }) => void;
  fail: (failure: StartupFailure) => void;
  clearFailure: () => void;
}

export const useWorkspaceStartupStore = create<WorkspaceStartupState>((set) => ({
  byDraftId: {},
  failure: null,
  begin: (progress) =>
    set((state) => ({
      byDraftId: { ...state.byDraftId, [progress.draftId]: progress },
      failure: null,
    })),
  fail: (failure) => set({ failure }),
  clearFailure: () => set((state) => (state.failure ? { failure: null } : state)),
  advance: ({ draftId, event }) =>
    set((state) => {
      const current = state.byDraftId[draftId];
      if (!current) return state;
      const next = advanceStartup(current, event);
      if (next === current) return state;
      return { byDraftId: { ...state.byDraftId, [draftId]: next } };
    }),
  discard: ({ draftId }) =>
    set((state) => {
      if (!state.byDraftId[draftId]) return state;
      const { [draftId]: _discarded, ...rest } = state.byDraftId;
      return { byDraftId: rest };
    }),
}));

interface DraftStartupKey {
  serverId: string;
  draftId: string | null | undefined;
}

function selectDraftStartup(
  state: WorkspaceStartupState,
  { serverId, draftId }: DraftStartupKey,
): StartupProgress | null {
  const progress = draftId ? state.byDraftId[draftId] : undefined;
  return progress?.serverId === serverId ? progress : null;
}

export function useDraftStartup(input: DraftStartupKey): StartupProgress | null {
  return useWorkspaceStartupStore((state) => selectDraftStartup(state, input));
}

export function getDraftStartup(input: DraftStartupKey): StartupProgress | null {
  return selectDraftStartup(useWorkspaceStartupStore.getState(), input);
}

export function useAgentStartup(input: {
  serverId: string;
  agentId: string;
}): StartupProgress | null {
  const { serverId, agentId } = input;
  return useWorkspaceStartupStore((state) => {
    for (const progress of Object.values(state.byDraftId)) {
      if (progress.serverId === serverId && progress.agentId === agentId) return progress;
    }
    return null;
  });
}

/** Whether a workspace is still on its way to an agent that can take the first message. */
export function useIsWorkspaceStarting(input: { serverId: string; workspaceId: string }): boolean {
  const { serverId, workspaceId } = input;
  return useWorkspaceStartupStore((state) => {
    for (const progress of Object.values(state.byDraftId)) {
      const isThisWorkspace =
        progress.serverId === serverId && progress.workspaceId === workspaceId;
      if (isThisWorkspace) return progress.agentReadyAt === null;
    }
    return false;
  });
}

/** The address of a workspace that failed to start, while someone may still be looking at it. */
export function useFailedStartupRoute(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const { serverId, workspaceId } = input;
  return useWorkspaceStartupStore((state) => {
    const failure = state.failure;
    const isThisWorkspace = failure?.serverId === serverId && failure.workspaceId === workspaceId;
    return isThisWorkspace ? failure.returnRoute : null;
  });
}
