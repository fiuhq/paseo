import pino from "pino";
import { describe, expect, test } from "vitest";
import type { PluginWorkspaceTitleRequest } from "@getpaseo/plugin/server";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { WorkspaceTitleGate, HELD_TITLE_STATE, isTitleHeld } from "./workspace-title-gate.js";

type Verdict = PluginWorkspaceTitleRequest["verdict"];

const PROMPT: FirstAgentContext = { prompt: "https://chat.example.com/archives/C0AB/p1793" };

function harness(options: {
  verdicts: (Verdict | Error)[];
  generated?: (
    context: FirstAgentContext,
  ) => { title: string | null; branch: string | null } | null;
  reply?: string | null;
}) {
  let record: PersistedWorkspaceRecord = {
    ...createPersistedWorkspaceRecord({
      workspaceId: "workspace-1",
      projectId: "project-1",
      cwd: "/workspace",
      kind: "worktree",
      displayName: "wretched-wombat",
      createdAt: "2026-11-06T00:00:00.000Z",
      updatedAt: "2026-11-06T00:00:00.000Z",
    }),
    titleState: HELD_TITLE_STATE,
  };
  const judged: PluginWorkspaceTitleRequest[] = [];
  const contexts: FirstAgentContext[] = [];
  const applied: { title: string | null; branch: string | null; unchecked: boolean }[] = [];
  const emitted: string[] = [];
  const subscribers: ((event: AgentManagerEvent) => void)[] = [];
  const verdicts = [...options.verdicts];

  const gate = new WorkspaceTitleGate({
    lifecycle: {
      handles: () => true,
      before: async (_name, request) => {
        judged.push(request);
        const next = verdicts.shift();
        if (next instanceof Error) throw next;
        return { ...request, verdict: next ?? null };
      },
    },
    agentManager: {
      subscribe: (callback: (event: AgentManagerEvent) => void) => {
        subscribers.push(callback);
        return () => {};
      },
      getAgent: () => ({ workspaceId: "workspace-1" }),
      getLastAssistantMessage: async () =>
        "reply" in options ? (options.reply ?? null) : "Preset child lookup crashes on one type.",
    } as unknown as Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">,
    workspaceRegistry: {
      get: async () => record,
      update: async (_id, updater) => {
        record = updater(record);
        return record;
      },
    },
    generate: async ({ firstAgentContext }) => {
      contexts.push(firstAgentContext);
      return options.generated
        ? options.generated(firstAgentContext)
        : { title: "Guess", branch: "guess" };
    },
    apply: async ({ generated, titleState }) => {
      applied.push({ ...generated, unchecked: titleState !== null });
      record = { ...record, title: generated.title, titleState };
    },
    emit: async (workspaceId) => {
      emitted.push(workspaceId);
    },
    logger: pino({ level: "silent" }),
  });

  return {
    gate,
    judged,
    contexts,
    applied,
    emitted,
    record: () => record,
    rename: (title: string) => {
      record = { ...record, title, titleState: null };
    },
    endTurn: async (type: "turn_completed" | "turn_failed" | "turn_canceled") => {
      for (const subscriber of subscribers) {
        subscriber({
          type: "agent_stream",
          agentId: "agent-1",
          event: { type },
        } as unknown as AgentManagerEvent);
      }
      await gate.settled("workspace-1");
    },
  };
}

const refuse = (score: number): Verdict => ({ decision: "refuse", score, judge: "Jev" });
const accept = (score: number): Verdict => ({ decision: "accept", score, judge: "Jev" });
const unchecked: Verdict = { decision: "unchecked", score: null, judge: "Jev" };

describe("WorkspaceTitleGate", () => {
  test("a title the judge accepts goes on at once, with the prompt as its source", async () => {
    const h = harness({ verdicts: [accept(0.92)] });

    await h.gate.start(h.record(), PROMPT);

    expect(h.applied).toEqual([{ title: "Guess", branch: "guess", unchecked: false }]);
    expect(h.judged[0]).toMatchObject({
      workspaceId: "workspace-1",
      candidate: { title: "Guess", branch: "guess" },
      source: "prompt",
      attempt: 1,
      verdict: null,
    });
  });

  test("a refused guess is never shown and the state says why", async () => {
    const h = harness({ verdicts: [refuse(0.42)] });

    await h.gate.start(h.record(), PROMPT);

    expect(h.applied).toEqual([]);
    expect(h.record().title).toBeNull();
    expect(h.record().titleState).toMatchObject({
      status: "refused",
      attempts: 1,
      refusedTitle: "Guess",
      score: 0.42,
      judge: "Jev",
    });
    expect(h.emitted).toEqual(["workspace-1"]);
  });

  test("the agent's reply feeds the next try, and a pass applies title and branch", async () => {
    const h = harness({
      verdicts: [refuse(0.42), accept(0.91)],
      generated: (context) =>
        context.prompt?.includes("Preset child lookup")
          ? { title: "Fix preset child lookup", branch: "fix-preset-child-lookup" }
          : { title: "Guess", branch: "guess" },
    });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_completed");

    expect(h.contexts[1]?.prompt).toContain(PROMPT.prompt);
    expect(h.contexts[1]?.prompt).toContain("Preset child lookup crashes on one type.");
    expect(h.judged[1]).toMatchObject({ source: "reply", attempt: 2 });
    expect(h.applied).toEqual([
      { title: "Fix preset child lookup", branch: "fix-preset-child-lookup", unchecked: false },
    ]);
  });

  test("a refused reply is retried at once, because the agent may never take another turn", async () => {
    const h = harness({
      verdicts: [refuse(0.24), refuse(0.55), accept(0.9)],
      generated: (context) => {
        if (context.prompt?.includes('refused the title "Second"')) {
          return {
            title: "Restore other accounts in the usage popover",
            branch: "restore-accounts",
          };
        }
        if (context.prompt?.includes("The agent has replied")) {
          return { title: "Second", branch: "second" };
        }
        return { title: "First", branch: "first" };
      },
    });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_completed");

    expect(h.judged.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(h.applied).toEqual([
      {
        title: "Restore other accounts in the usage popover",
        branch: "restore-accounts",
        unchecked: false,
      },
    ]);
  });

  test("three refusals end with no title and the state says so, in one turn", async () => {
    const h = harness({ verdicts: [refuse(0.1), refuse(0.2), refuse(0.3), accept(0.9)] });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_completed");
    await h.endTurn("turn_completed");

    expect(h.judged).toHaveLength(3);
    expect(h.applied).toEqual([]);
    expect(h.record().titleState).toMatchObject({ status: "exhausted", attempts: 3 });
  });

  test.each(["turn_failed", "turn_canceled"] as const)(
    "%s with no reply leaves the workspace unnamed and says so",
    async (type) => {
      const h = harness({ verdicts: [refuse(0.42)], reply: null });

      await h.gate.start(h.record(), PROMPT);
      await h.endTurn(type);

      expect(h.judged).toHaveLength(1);
      expect(h.record().titleState).toMatchObject({ status: "no-reply", refusedTitle: "Guess" });
    },
  );

  test("an agent that replies after failing once can still earn the title", async () => {
    const h = harness({ verdicts: [refuse(0.42), accept(0.9)] });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_failed");
    await h.endTurn("turn_completed");

    expect(h.applied).toHaveLength(1);
  });

  test("a judge that says unchecked lets the title on, marked", async () => {
    const h = harness({ verdicts: [unchecked] });

    await h.gate.start(h.record(), PROMPT);

    expect(h.applied).toEqual([{ title: "Guess", branch: "guess", unchecked: true }]);
    expect(h.record().titleState).toMatchObject({ status: "unchecked", judge: "Jev" });
    expect(isTitleHeld(h.record().titleState)).toBe(false);
  });

  test("a hook that throws cannot stop naming: the title goes on, marked", async () => {
    const h = harness({ verdicts: [new Error("plugin crashed")] });

    await h.gate.start(h.record(), PROMPT);

    expect(h.applied).toEqual([{ title: "Guess", branch: "guess", unchecked: true }]);
    expect(h.record().titleState).toMatchObject({ status: "unchecked", judge: null });
  });

  test("a manual rename wins: a later turn changes nothing", async () => {
    const h = harness({ verdicts: [refuse(0.42), accept(0.9)] });

    await h.gate.start(h.record(), PROMPT);
    h.rename("My own name");
    await h.endTurn("turn_completed");

    expect(h.judged).toHaveLength(1);
    expect(h.record().title).toBe("My own name");
  });

  test("a rename that lands while the judge is scoring is not overwritten", async () => {
    const h = harness({ verdicts: [] });
    const original = h.record();
    let renamed = false;
    const late = new WorkspaceTitleGate({
      lifecycle: {
        handles: () => true,
        before: async (_name, request) => {
          h.rename("My own name");
          renamed = true;
          return { ...request, verdict: { decision: "accept", score: 0.9, judge: "Jev" } };
        },
      },
      agentManager: {
        subscribe: () => () => {},
      } as unknown as Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">,
      workspaceRegistry: {
        get: async () => h.record(),
        update: async (_id, updater) => updater(h.record()),
      },
      generate: async () => ({ title: "Guess", branch: "guess" }),
      apply: async () => {
        throw new Error("must not apply over a manual rename");
      },
      emit: async () => {},
      logger: pino({ level: "silent" }),
    });

    await late.start(original, PROMPT);

    expect(renamed).toBe(true);
    expect(h.record().title).toBe("My own name");
  });

  test("a generator that fails counts as a try, so the workspace cannot wait forever", async () => {
    const h = harness({ verdicts: [], generated: () => null });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_completed");
    await h.endTurn("turn_completed");

    expect(h.judged).toEqual([]);
    expect(h.record().titleState).toMatchObject({ status: "exhausted", attempts: 3 });
  });

  test("only a held workspace reacts to turns", async () => {
    const h = harness({ verdicts: [accept(0.9), accept(0.9)] });

    await h.gate.start(h.record(), PROMPT);
    await h.endTurn("turn_completed");

    expect(h.judged).toHaveLength(1);
  });

  test("a turn that ends while the first try is running waits its turn", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ verdicts: [refuse(0.42), accept(0.9)] });
    const generate = h.gate["deps"].generate;
    h.gate["deps"].generate = async (input) => {
      await held;
      return generate(input);
    };

    const started = h.gate.start(h.record(), PROMPT);
    const ended = h.endTurn("turn_completed");
    release();
    await Promise.all([started, ended]);

    expect(h.judged.map((request) => request.attempt)).toEqual([1, 2]);
    expect(h.applied).toHaveLength(1);
  });
});
