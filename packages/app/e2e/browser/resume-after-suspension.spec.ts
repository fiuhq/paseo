import { expect, test as base } from "../support/fixtures";
import type { Page, WebSocketRoute } from "@playwright/test";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { seedSavedSettingsHosts } from "../support/helpers/settings";

// A phone that suspends the page for a minute usually loses the socket without a close frame: the
// radio sleeps, a NAT entry expires, and the daemon closes its end once its 45 s lease runs out.
// The page wakes up to a socket that still reads OPEN and accepts sends. This spec rebuilds that
// on a desktop browser: Playwright's clock stops the page's timers and moves its wall clock, the
// way a frozen page sees time, and a WebSocket route silently drops every frame of the old socket.

const test = base.extend<{ resumeHost: IsolatedHostDaemon }>({
  resumeHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const daemon = await startIsolatedHostDaemon("resume-after-suspension");
    try {
      await provide(daemon);
    } finally {
      await daemon.close();
    }
  },
});

test.describe.configure({ timeout: 120_000 });

interface SilentSocketRoute {
  pingsFromPage(): number;
  silenceCurrentSockets(): void;
  connectionCount(): number;
}

async function routeDaemonSockets(page: Page, port: number): Promise<SilentSocketRoute> {
  const silenced = new Set<WebSocketRoute>();
  const open = new Set<WebSocketRoute>();
  let pings = 0;
  let connections = 0;
  await page.routeWebSocket(wsRoutePatternForPort(String(port)), (ws) => {
    connections += 1;
    open.add(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (silenced.has(ws)) return;
      if (typeof message === "string" && message.includes('"type":"ping"')) pings += 1;
      server.send(message);
    });
    server.onMessage((message) => {
      if (!silenced.has(ws)) ws.send(message);
    });
    // A dead path delivers no close frame either way.
    ws.onClose((code, reason) => {
      open.delete(ws);
      if (!silenced.has(ws)) void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      if (!silenced.has(ws)) void ws.close({ code, reason });
    });
  });
  return {
    pingsFromPage: () => pings,
    silenceCurrentSockets: () => {
      for (const ws of open) silenced.add(ws);
    },
    connectionCount: () => connections,
  };
}

async function setTabVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => state === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

test("a page suspended past the daemon lease reconnects as soon as it is visible again", async ({
  page,
  resumeHost,
}, testInfo) => {
  await page.clock.install();
  const sockets = await routeDaemonSockets(page, resumeHost.port);
  await page.goto("/");
  await seedSavedSettingsHosts(page, [
    { serverId: resumeHost.serverId, label: "Resume QA", endpoint: `127.0.0.1:${resumeHost.port}` },
  ]);
  await page.goto(`/settings/hosts/${resumeHost.serverId}/host`);
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  // The first heartbeat claims the daemon's lease on this socket.
  await expect.poll(() => sockets.pingsFromPage(), { timeout: 30_000 }).toBeGreaterThan(0);
  const connectionsBefore = sockets.connectionCount();

  // Suspend: hide the page, stop its timers, kill the path silently, let 70 s of wall clock pass.
  await setTabVisibility(page, "hidden");
  const suspendedAt = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(suspendedAt + 100);
  sockets.silenceCurrentSockets();
  await page.clock.setSystemTime(suspendedAt + 70_000);
  await page.screenshot({ path: testInfo.outputPath("suspended.png") });

  // Resume.
  const resumedAt = Date.now();
  await setTabVisibility(page, "visible");
  await page.clock.resume();
  await expect
    .poll(() => sockets.connectionCount(), { timeout: 30_000, intervals: [50] })
    .toBeGreaterThan(connectionsBefore);
  const reconnectMs = Date.now() - resumedAt;
  await expect(page.getByText("Online", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("resumed.png") });
  testInfo.annotations.push({ type: "reconnect-ms", description: String(reconnectMs) });
  console.log(`[resume-after-suspension] new socket ${reconnectMs} ms after the page was visible`);
  expect(reconnectMs).toBeLessThan(2_000);
});
