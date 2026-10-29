/**
 * @vitest-environment jsdom
 */
import appPackage from "../../package.json";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

vi.mock("@/plugins/evaluate", () => ({
  runPluginClientBundle: () => ({ cleanup: async () => {} }),
}));
vi.mock("@/plugins/client-runtime", () => ({
  createPluginClientRuntime: vi.fn(),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => feature === "plugins",
}));

import { syncPluginCatalog } from "@/plugins/catalog-sync-model";
import { pluginRegistry } from "@/plugins/registry";
import { useUsageFeedKind, ZEROSUB_PLUGIN_ID } from "./feed";

const audio = { play: async () => 0 };
const requirements = { paseo: `>=${appPackage.version}` };

function client(getPluginCatalog: () => Promise<unknown>): DaemonClient {
  return {
    getPluginCatalog,
    observeEvents: () => ({
      subscribe: (observer: { snapshot: (snapshot: unknown) => void }) => {
        observer.snapshot({ requestId: "events", subscriptionId: "catalog" });
        return () => {};
      },
      release: async () => {},
    }),
  } as unknown as DaemonClient;
}

afterEach(() => {
  pluginRegistry.removeHost("host");
});

it("knows no feed for a plugin host until its catalog lands, then follows the ZeroSub install", () => {
  const { result } = renderHook(() => useUsageFeedKind("host"));
  expect(result.current).toBeNull();

  act(() => {
    pluginRegistry.installCatalog(
      "host",
      [{ id: ZEROSUB_PLUGIN_ID, clientBundle: "zerosub-bundle", requirements }],
      { client: {} as DaemonClient, audio },
    );
  });
  expect(result.current).toBe("zerosub");
});

it("reads the daemon's usage once a plugin host's first catalog load fails", async () => {
  const { result } = renderHook(() => useUsageFeedKind("host"));
  expect(result.current).toBeNull();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stop = syncPluginCatalog({
    serverId: "host",
    client: client(async () => {
      throw new Error("catalog timeout");
    }),
    audio,
    connected: true,
    supported: true,
    registry: pluginRegistry,
  });
  try {
    await waitFor(() => expect(result.current).toBe("daemon"));
  } finally {
    stop();
    warn.mockRestore();
  }
});
