import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

let ctx: DaemonTestContext;
let resumes: number;
let cwd: string;

beforeEach(async () => {
  resumes = 0;
  cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-unloaded-"));
  ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      beforeResumeSession: async () => {
        resumes += 1;
      },
    }),
  });
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60_000);

function entryTexts(
  entries: readonly { item: { type: string; text?: string } }[],
): (string | undefined)[] {
  return entries.map((entry) => entry.item.text);
}

test("a client reads a closed agent's chat from the parked timeline without resuming the agent", async () => {
  const manager = ctx.daemon.daemon.agentManager;
  const agent = await ctx.client.createAgent({
    provider: "codex",
    cwd,
    title: "Parked",
    modeId: "full-access",
  });
  for (let row = 1; row <= 30; row += 1) {
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: `row ${row}`,
      messageId: `m-${row}`,
    });
  }
  const before = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 50 });
  const earlier = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 10 });
  expect(before.endCursor).not.toBeNull();

  // What the idle cleanup does after an hour: the runtime closes.
  await manager.closeAgent(agent.id);
  expect(manager.getAgent(agent.id)).toBeNull();
  expect(readdirSync(path.join(ctx.daemon.paseoHome, "parked-timelines")).sort()).toEqual([
    `${agent.id}.head.json`,
    `${agent.id}.json`,
  ]);

  // Opening the chat again: the same page, the same epoch, no resume.
  const reopened = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 50 });
  expect(reopened.epoch).toBe(before.epoch);
  expect(entryTexts(reopened.entries)).toEqual(entryTexts(before.entries));
  expect(reopened.agent?.id).toBe(agent.id);

  // A client that saw only the first rows catches up the rest from its cursor.
  const startCursor = earlier.startCursor;
  expect(startCursor).not.toBeNull();
  const caughtUp = await ctx.client.fetchAgentTimeline(agent.id, {
    direction: "after",
    cursor: { epoch: before.epoch, seq: (startCursor?.seq ?? 1) - 1 },
    limit: 50,
  });
  expect(entryTexts(caughtUp.entries)).toEqual(entryTexts(earlier.entries));

  // Returning to a chat already at the head: the freshness check answers current, with the agent row.
  const subscription = ctx.client.observeTimeline([agent.id], {
    cursors: { [agent.id]: { epoch: before.epoch, seq: before.endCursor?.seq ?? 0 } },
  });
  const ready = await subscription.ready;
  expect(ready).toMatchObject({ timelines: { [agent.id]: "current" } });
  expect(ready).toMatchObject({ agents: { [agent.id]: { id: agent.id } } });

  // Reconnect also lists subagents for every opened chat.
  const subagents = await ctx.client.listProviderSubagents(agent.id);
  expect(subagents.subagents).toEqual([]);

  expect(resumes).toBe(0);
  expect(manager.getAgent(agent.id)).toBeNull();

  // Typing resumes the agent, which keeps the timeline's epoch and sequence.
  await ctx.client.sendAgentMessage(agent.id, "continue");
  await ctx.client.waitForFinish(agent.id, 15_000);
  expect(resumes).toBe(1);
  const resumed = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 50 });
  expect(resumed.epoch).toBe(before.epoch);
  expect(readdirSync(path.join(ctx.daemon.paseoHome, "parked-timelines"))).toEqual([]);
}, 60_000);
