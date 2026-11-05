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

export function useDraftStartup(input: {
  serverId: string;
  draftId: string | null | undefined;
}): StartupProgress | null {
  const { serverId, draftId } = input;
  return useWorkspaceStartupStore((state) => {
    const progress = draftId ? state.byDraftId[draftId] : undefined;
    return progress?.serverId === serverId ? progress : null;
  });
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
