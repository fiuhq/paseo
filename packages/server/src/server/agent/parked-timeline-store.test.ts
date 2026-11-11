import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineFetchOptions } from "./agent-timeline-store-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { ParkedTimelineStore } from "./parked-timeline-store.js";

const AGENT = "agent-1";

function toolCall(callId: string, status: "running" | "completed"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "unknown", input: { callId }, output: status === "completed" ? "ok" : null },
  };
}

/** A timeline whose projection merges: streamed assistant and reasoning chunks, tool-call lifecycles. */
function fillTimeline(store: InMemoryAgentTimelineStore): void {
  store.initialize(AGENT, { epoch: "epoch-1" });
  for (let turn = 0; turn < 6; turn++) {
    const turnId = `turn-${turn}`;
    store.append(
      AGENT,
      { type: "user_message", text: `prompt ${turn}`, messageId: `u-${turn}` },
      { turnId },
    );
    store.append(AGENT, { type: "reasoning", text: "thinking " }, { turnId });
    store.append(AGENT, { type: "reasoning", text: "harder" }, { turnId });
    store.append(AGENT, toolCall(`call-${turn}`, "running"), { turnId });
    store.append(
      AGENT,
      { type: "assistant_message", text: "Hel", messageId: `m-${turn}` },
      { turnId },
    );
    store.append(AGENT, toolCall(`call-${turn}`, "completed"), { turnId });
    store.append(
      AGENT,
      { type: "assistant_message", text: "lo", messageId: `m-${turn}` },
      { turnId },
    );
  }
}

/** Every read a client makes: tails, each forward and backward cursor, whole turns, a stale epoch. */
function reads(store: InMemoryAgentTimelineStore): AgentTimelineFetchOptions[] {
  const { seq } = store.getHead(AGENT);
  const options: AgentTimelineFetchOptions[] = [{}, { limit: 3 }, { limit: 40, wholeTurns: true }];
  for (let at = 0; at <= seq; at++) {
    options.push({ direction: "after", cursor: { epoch: "epoch-1", seq: at }, limit: 5 });
    options.push({
      direction: "before",
      cursor: { epoch: "epoch-1", seq: at },
      limit: 4,
      wholeTurns: true,
    });
  }
  options.push({ direction: "after", cursor: { epoch: "other", seq: 3 } });
  return options;
}

describe("ParkedTimelineStore", () => {
  let directory: string;
  const logged: unknown[] = [];
  const logger = {
    warn: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "parked-timeline-"));
    logged.length = 0;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("answers every read of a released timeline from disk exactly as memory did, holding none of it", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    const options = reads(store);
    const before = options.map((option) => store.fetch(AGENT, option));
    const head = store.getHead(AGENT);

    await store.release(AGENT);

    expect(store.has(AGENT)).toBe(true);
    expect(
      (store as unknown as { resident(id: string): object | undefined }).resident(AGENT),
    ).toBeUndefined();
    expect((await readdir(directory)).sort()).toEqual([`${AGENT}.head.json`, `${AGENT}.json`]);
    expect(await store.peekHead(AGENT)).toEqual(head);
    for (const [index, option] of options.entries()) {
      expect(await store.peekFetch(AGENT, option)).toEqual(before[index]);
    }
    // Reading did not bring it back into memory.
    expect(
      (store as unknown as { resident(id: string): object | undefined }).resident(AGENT),
    ).toBeUndefined();
  });

  it("brings a released timeline back exactly on the next access, keeping its epoch and sequence", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    const options = reads(store);
    const before = options.map((option) => store.fetch(AGENT, option));
    const head = store.getHead(AGENT);
    await store.release(AGENT);

    expect(() => store.getHead(AGENT)).toThrow("was released; load it first");
    await store.load(AGENT);
    expect(store.getHead(AGENT)).toEqual(head);
    expect(options.map((option) => store.fetch(AGENT, option))).toEqual(before);
    const row = store.append(
      AGENT,
      { type: "user_message", text: "back", messageId: "u-back" },
      { turnId: "t" },
    );
    expect(row.seq).toBe(head.seq + 1);
    expect(store.getEpoch(AGENT)).toBe("epoch-1");
    await store.peekHead(AGENT);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps the timeline in memory when the agent writes while the file is being written", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    const releasing = store.release(AGENT);
    store.append(
      AGENT,
      { type: "user_message", text: "racing", messageId: "u-race" },
      { turnId: "t" },
    );
    await releasing;

    expect(
      (store as unknown as { resident(id: string): object | undefined }).resident(AGENT),
    ).toBeDefined();
    expect(store.getLastItem(AGENT)).toMatchObject({ type: "user_message", text: "racing" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("serves an earlier daemon run's file to reads but rebuilds from the provider on resume", async () => {
    const first = new ParkedTimelineStore({ directory, logger });
    fillTimeline(first);
    const head = first.getHead(AGENT);
    const tail = first.fetch(AGENT, { limit: 40, wholeTurns: true });
    await first.release(AGENT);

    const restarted = new ParkedTimelineStore({ directory, logger });

    expect(restarted.has(AGENT)).toBe(false);
    expect(await restarted.peekHead(AGENT)).toEqual(head);
    expect(await restarted.peekFetch(AGENT, { limit: 40, wholeTurns: true })).toEqual(tail);
    restarted.initialize(AGENT, { epoch: "rebuilt" });
    await restarted.peekHead(AGENT);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reads a parked file without a subagent list as no subagents, and no file as nothing held", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    expect(await store.peekProviderSubagents(AGENT)).toBeNull();
    await writeFile(
      path.join(directory, `${AGENT}.json`),
      JSON.stringify({ version: 1, epoch: "epoch-1", nextSeq: 1, rows: [] }),
    );

    expect(await store.peekProviderSubagents(AGENT)).toEqual([]);
  });

  it("removes the file when the timeline is deleted", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    await store.release(AGENT);
    store.delete(AGENT);

    expect(store.has(AGENT)).toBe(false);
    expect(await store.peekHead(AGENT)).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it("falls back to provider history, and says so, when a parked file cannot be read", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    await store.release(AGENT);
    await writeFile(path.join(directory, `${AGENT}.json`), "{not json");

    await store.load(AGENT);

    expect(store.has(AGENT)).toBe(false);
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps the timeline in memory when the agent resumes while the file is being written", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    fillTimeline(store);
    const releasing = store.release(AGENT);
    await store.load(AGENT);
    await releasing;

    expect(
      (store as unknown as { resident(id: string): object | undefined }).resident(AGENT),
    ).toBeDefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps a timeline in memory when its id is not a safe file name", async () => {
    const store = new ParkedTimelineStore({ directory, logger });
    store.initialize("../escape", { epoch: "e" });
    await store.release("../escape");

    expect(
      (store as unknown as { resident(id: string): object | undefined }).resident("../escape"),
    ).toBeDefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps the in-memory store's behaviour: release retains, peeks read memory", async () => {
    const store = new InMemoryAgentTimelineStore();
    fillTimeline(store);
    const tail = store.fetch(AGENT, { limit: 3 });
    await store.release(AGENT);

    expect(await store.peekHead(AGENT)).toEqual(store.getHead(AGENT));
    expect(await store.peekFetch(AGENT, { limit: 3 })).toEqual(tail);
    expect(await store.peekHead("missing")).toBeNull();
  });
});
