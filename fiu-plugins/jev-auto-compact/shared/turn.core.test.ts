import { describe, expect, test } from "bun:test";

import { byteLength } from "./redact.core";
import {
  describeTurn,
  digestOf,
  readTurn,
  turnKey,
  DESCRIPTION_BYTES,
  type TimelineLike,
} from "./turn.core";

const user = (text: string, messageId = "u1"): TimelineLike => ({
  type: "user_message",
  text,
  messageId,
});
const assistant = (text: string, messageId = "a1"): TimelineLike => ({
  type: "assistant_message",
  text,
  messageId,
});
const tool = (name: string, status = "completed", callId = "c1"): TimelineLike => ({
  type: "tool_call",
  name,
  status,
  callId,
});

/**
 * The real delivered shape, recorded from `agent.turn_ended` on 2026-09-21: partials
 * repeat under one id, and a tool call ends with a `completed` entry after its `running`
 * ones. Two exchanges arrived as 13 entries.
 */
const STREAMED: TimelineLike[] = [
  assistant("Written", "a0"),
  assistant(" — the file", "a0"),
  assistant(" exists.", "a0"),
  user("append a second line", "u1"),
  tool("Bash", "running", "c9"),
  tool("Bash", "running", "c9"),
  tool("Bash", "running", "c9"),
  tool("Bash", "completed", "c9"),
  assistant("App", "a1"),
  assistant("ended.", "a1"),
];

describe("readTurn", () => {
  test("a streamed tool call that finished is not still running", () => {
    const view = readTurn(STREAMED);
    expect(view.runningTools).toBe(0);
    expect(view.toolNames).toEqual(["Bash"]);
  });

  test("counts messages, not the partials they streamed as", () => {
    const view = readTurn(STREAMED);
    expect(view.userMessages).toBe(1);
    expect(view.assistantMessages).toBe(2);
    expect(view.entryCount).toBe(10);
    expect(view.lastAssistantText).toBe("Appended.");
    expect(view.lastUserText).toBe("append a second line");
  });

  test("reads failures and errors from each call's latest entry", () => {
    const view = readTurn([
      user("fix the parser"),
      tool("Read", "running", "c1"),
      tool("Read", "completed", "c1"),
      tool("Bash", "running", "c2"),
      tool("Bash", "failed", "c2"),
      { type: "error", message: "provider rejected the request" },
      assistant("that failed"),
    ]);
    expect(view.failedTools).toBe(1);
    expect(view.runningTools).toBe(0);
    expect(view.errors).toBe(1);
    expect(view.toolNames).toEqual(["Read", "Bash"]);
  });

  test("a tool call still running at turn end is reported as running", () => {
    expect(readTurn([user("go"), tool("Bash", "running", "c1")]).runningTools).toBe(1);
  });

  test("a call left running in an EARLIER exchange is stranded, not running", () => {
    // The measured shape: a terminal entry that never arrived, in a stream that never
    // drops one. Counting it as running refuses this agent on every turn from here on.
    const view = readTurn([
      user("first ask", "u1"),
      tool("Bash", "running", "stranded"),
      assistant("done", "a1"),
      user("second ask", "u2"),
      tool("Read", "completed", "c2"),
      assistant("done again", "a2"),
    ]);

    expect(view.runningTools).toBe(0);
    expect(view.strandedTools).toBe(1);
  });

  test("…and stays stranded when a LATER running entry arrives for it after the person spoke", () => {
    // A stream repeats a call's `running` entry, so the newest one can land after the next
    // message from the person. Classified by that entry, the call would look current and
    // refuse every turn from here on — the exact failure this whole rule exists to end.
    const view = readTurn([
      user("first ask", "u1"),
      tool("Bash", "running", "stranded"),
      assistant("working", "a1"),
      user("second ask", "u2"),
      tool("Bash", "running", "stranded"),
      assistant("done", "a2"),
    ]);

    expect(view.runningTools).toBe(0);
    expect(view.strandedTools).toBe(1);
  });

  test("…while a call started in the exchange that just ended still counts", () => {
    const view = readTurn([
      user("first ask", "u1"),
      tool("Bash", "running", "stranded"),
      user("second ask", "u2"),
      tool("Bash", "running", "background"),
    ]);

    expect(view.runningTools).toBe(1);
    expect(view.strandedTools).toBe(1);
  });

  test("the judge is told about both, so it can read the turn for itself", () => {
    const view = readTurn([
      user("first", "u1"),
      tool("Bash", "running", "stranded"),
      user("second", "u2"),
      tool("Bash", "running", "live"),
    ]);
    expect(describeTurn(view, { contextWindowUsedTokens: 1 })).toContain(
      "Tool calls still running: 1 (and 1 left unfinished in earlier exchanges)",
    );
  });

  test("rebuilds an answer streamed as deltas, which is what Claude actually sends", () => {
    const view = readTurn([
      user("append a line"),
      assistant("Appended. The file now reads: f", "a1"),
      assistant("ourth probe fifth probe", "a1"),
    ]);
    expect(view.lastAssistantText).toBe("Appended. The file now reads: fourth probe fifth probe");
    expect(view.assistantMessages).toBe(1);
  });

  test("keeps every delta, including one that repeats or extends an earlier chunk", () => {
    expect(
      readTurn([assistant("I", "a1"), assistant("Implemented the fix", "a1")]).lastAssistantText,
    ).toBe("IImplemented the fix");
    expect(readTurn([assistant("ha", "a1"), assistant("ha", "a1")]).lastAssistantText).toBe("haha");
  });

  test("a new message from the person clears the previous answer", () => {
    const view = readTurn([assistant("done"), user("now the tests", "u2")]);
    expect(view.lastAssistantText).toBe("");
    expect(view.lastUserText).toBe("now the tests");
  });

  test("counts messages since the newest completed compaction", () => {
    const timeline = [
      user("a", "u1"),
      assistant("b", "a1"),
      { type: "compaction", status: "completed" },
      user("c", "u2"),
      assistant("d", "a2"),
      assistant("d.", "a2"),
    ];
    expect(readTurn(timeline).messagesSinceCompaction).toBe(2);
    expect(readTurn([user("a", "u1"), assistant("b", "a1")]).messagesSinceCompaction).toBe(2);
  });

  test("a compaction still loading does not count as one", () => {
    const view = readTurn([user("a", "u1"), { type: "compaction", status: "loading" }]);
    expect(view.messagesSinceCompaction).toBe(1);
  });

  test("survives entries with no ids at all", () => {
    const view = readTurn([
      { type: "user_message", text: "a" },
      { type: "assistant_message", text: "b" },
      { type: "tool_call", name: "Bash", status: "completed" },
    ]);
    expect(view.userMessages).toBe(1);
    expect(view.assistantMessages).toBe(1);
    expect(view.toolNames).toEqual(["Bash"]);
  });
});

describe("turnKey", () => {
  test("separates two turns that share a repeated turnId", () => {
    const first = readTurn([user("a", "u1"), assistant("b", "a1")]);
    const second = readTurn([
      user("a", "u1"),
      assistant("b", "a1"),
      user("c", "u2"),
      assistant("d", "a2"),
    ]);
    expect(turnKey("agent", "turn-1", first)).not.toBe(turnKey("agent", "turn-1", second));
  });

  test("is stable for the same delivered event, which is what makes acting once possible", () => {
    expect(turnKey("agent", "turn-1", readTurn(STREAMED))).toBe(
      turnKey("agent", "turn-1", readTurn(STREAMED)),
    );
  });

  test("separates two agents at the same point in their timelines", () => {
    const view = readTurn(STREAMED);
    expect(turnKey("agent-one", null, view)).not.toBe(turnKey("agent-two", null, view));
  });
});

describe("digestOf", () => {
  test("mixes the separator, so the same characters split differently differ", () => {
    expect(digestOf(["ab", "c"])).not.toBe(digestOf(["a", "bc"]));
  });
});

describe("describeTurn", () => {
  test("describes the turn without leaking identifiers, within a bounded size", () => {
    const view = readTurn([
      user("deploy https://internal.acme.io/app from /Users/someone/src"),
      tool("Bash", "completed", "c1"),
      tool("Bash", "completed", "c2"),
      assistant("deployed; the log is at /var/log/acme/deploy.log"),
    ]);
    const text = describeTurn(
      view,
      { contextWindowUsedTokens: 400_000, contextWindowMaxTokens: 1_000_000 },
      ["acme"],
    );

    expect(text).toContain("Context used: 400000 of 1000000 tokens.");
    expect(text).toContain("Bash x2");
    expect(text).not.toContain("acme");
    expect(text).not.toContain("/Users/someone");
    expect(text.length).toBeLessThan(2_048);
  });

  test("says so plainly when the runtime reports no context size", () => {
    expect(describeTurn(readTurn([assistant("hi")]), {})).toContain("Context used: unknown");
  });

  test("stays bounded when the conversation is enormous", () => {
    const view = readTurn([user("x".repeat(50_000)), assistant("y".repeat(50_000))]);
    expect(describeTurn(view, {}).length).toBeLessThan(2_048);
  });
});

describe("describeTurn tool names", () => {
  test("redacts and clips a tool name like any other emitted text", () => {
    const view = readTurn([
      user("go"),
      tool(`mcp__northwind__${"q".repeat(500)}`, "completed", "c1"),
    ]);
    const state = describeTurn(view, {}, ["northwind"]);
    expect(state).not.toContain("northwind");
    expect(state.length).toBeLessThan(2_500);
  });
});

describe("describeTurn size", () => {
  test("is bounded in BYTES, whatever script the conversation was written in", () => {
    const view = readTurn([
      user("请修复这个错误".repeat(300)),
      assistant("我已经修复并通过了测试".repeat(300)),
    ]);
    const state = describeTurn(view, {
      contextWindowUsedTokens: 400_000,
      contextWindowMaxTokens: 1_000_000,
    });
    expect(byteLength(state)).toBeLessThanOrEqual(DESCRIPTION_BYTES);
  });
});
