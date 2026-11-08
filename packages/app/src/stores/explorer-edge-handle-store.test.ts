import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createExplorerEdgeHandleStore } from "./explorer-edge-handle-store";

function memoryStorage(entries: Record<string, string | null> = {}): StateStorage<Promise<void>> & {
  entries: Record<string, string | null>;
} {
  return {
    entries,
    getItem: async (name) => entries[name] ?? null,
    setItem: async (name, value) => {
      entries[name] = value;
    },
    removeItem: async (name) => {
      entries[name] = null;
    },
  };
}

describe("Explorer edge handle store", () => {
  it("starts in the middle of the column", async () => {
    const store = createExplorerEdgeHandleStore(memoryStorage());
    await store.persist.rehydrate();
    expect(store.getState().offset).toBe(0.5);
  });

  it("keeps where the user left the handle on this device", async () => {
    const storage = memoryStorage();
    const first = createExplorerEdgeHandleStore(storage);
    await first.persist.rehydrate();
    first.getState().setOffset(0.25);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reopened = createExplorerEdgeHandleStore(storage);
    await reopened.persist.rehydrate();
    expect(reopened.getState().offset).toBe(0.25);
  });

  it("brings a stored offset that left the column back onto it", async () => {
    const storage = memoryStorage({
      "explorer-edge-handle": JSON.stringify({ state: { offset: 4 }, version: 1 }),
    });
    const store = createExplorerEdgeHandleStore(storage);
    await store.persist.rehydrate();
    expect(store.getState().offset).toBe(0.95);
  });
});
