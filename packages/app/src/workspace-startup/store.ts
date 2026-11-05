import { create } from "zustand";
import { advanceStartup, type StartupEvent, type StartupProgress } from "./progress";

interface WorkspaceStartupState {
  byDraftId: Record<string, StartupProgress>;
  begin: (progress: StartupProgress) => void;
  advance: (input: { draftId: string; event: StartupEvent }) => void;
  discard: (input: { draftId: string }) => void;
}

export const useWorkspaceStartupStore = create<WorkspaceStartupState>((set) => ({
  byDraftId: {},
  begin: (progress) =>
    set((state) => ({ byDraftId: { ...state.byDraftId, [progress.draftId]: progress } })),
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
