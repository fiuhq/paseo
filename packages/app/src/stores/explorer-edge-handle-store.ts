import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import {
  clampEdgeHandleOffset,
  EDGE_HANDLE_DEFAULT_OFFSET,
} from "@/screens/workspace/explorer-sidebar/edge-handle-geometry";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const EXPLORER_EDGE_HANDLE_STORAGE_KEY = "explorer-edge-handle";

/** Where the user left the Explorer edge handle on this device: a fraction of the column height. */
interface ExplorerEdgeHandleState {
  offset: number;
  setOffset(offset: number): void;
}

const PersistedSchema = z.object({ offset: z.number() });

export function createExplorerEdgeHandleStore(backingStorage: StateStorage = AsyncStorage) {
  return create<ExplorerEdgeHandleState>()(
    persist(
      (set) => ({
        offset: EDGE_HANDLE_DEFAULT_OFFSET,
        setOffset: (offset) => set({ offset: clampEdgeHandleOffset(offset) }),
      }),
      {
        name: EXPLORER_EDGE_HANDLE_STORAGE_KEY,
        version: 1,
        storage: createValidatedPersistStorage(backingStorage, PersistedSchema),
        partialize: (state) => ({ offset: state.offset }),
        merge: (persisted, current) => {
          const stored = PersistedSchema.safeParse(persisted);
          return {
            ...current,
            offset: clampEdgeHandleOffset(stored.success ? stored.data.offset : current.offset),
          };
        },
      },
    ),
  );
}

export const useExplorerEdgeHandleStore = createExplorerEdgeHandleStore();
