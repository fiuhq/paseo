import { describe, expect, test } from "bun:test";
import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createWorkfloorProvider } from "./provider";

const P = "proj-1";
const A = "agent-1";
const AUTH = { url: "https://wf.test", token: "wfpat_test" };

/**
 * Workfloor as its routes answer a personal token: one project with one agent, conversations that start
 * an agent, and a live stream that sends an event whenever a conversation changes.
 */
class FakeWorkfloor {
  cards = new Map<
    string,
    {
      title: string;
      state: string;
      messages: Array<Record<string, unknown>>;
      agent: string;
      /** The card's lane: a conversation's when unset. */
      lane?: string;
      /** The card's current agent session, once its lane moved it on to another stage's agent. */
      session?: string;
      pending?: string;
      /** The agent's `card_ask` waiting on the person, as Workfloor's questions route reads it. */
      asks?: Record<string, unknown>;
      answered?: Record<string, unknown>;
    }
  >();
  requests: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  /** What the agent does with a message: by default it works a moment, then answers and waits. */
  reply = (card: string, words: string) => {
    setTimeout(() => {
      const c = this.cards.get(card)!;
      c.state = "RUNNING";
      c.messages.push({
        id: `m${c.messages.length + 1}`,
        role: "agent",
        body: "",
        tool: { name: "Read", status: "completed", input: "README.md" },
      });
      c.messages.push({
        id: `m${c.messages.length + 1}`,
        role: "agent",
        body: `Hello! You said: ${words}`,
      });
      this.changed();
      setTimeout(() => {
        c.state = "WAITING_FOR_INPUT";
        this.changed();
      }, 20);
    }, 20);
  };

  /** How long each read of a conversation takes. */
  detailDelay = 0;

  changed() {
    for (const s of this.streams)
      s.enqueue(new TextEncoder().encode(`data: {"type":"invalidate"}\n\n`));
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body,
      auth,
    });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    const q = url.searchParams;
    if (url.pathname === "/api/events") {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          this.streams.add(c);
          c.enqueue(
            new TextEncoder().encode(
              `retry: 2000\n\ndata: {"type":"state","state":"connecting"}\n\n`,
            ),
          );
        },
      });
      init?.signal?.addEventListener("abort", () => {
        this.streams.delete(controller);
        controller.close();
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/connection" && q.get("view") === "bootstrap")
      return json({ projects: [{ id: P, name: "codev" }] });
    if (url.pathname === "/api/connection" && q.get("view") === "agents")
      return json([{ id: A, name: "Buildy", model: "claude-opus-5-5" }]);
    if (url.pathname === "/api/connection" && q.get("view") === "detail") {
      await Bun.sleep(this.detailDelay);
      const c = this.cards.get(q.get("task")!);
      if (!c || q.get("workflow") !== (c.lane ?? `conversations:${P}`))
        return json({ error: "Not found" }, 404);
      const session = c.session ?? `s-${q.get("task")}`;
      return json({
        title: c.title,
        sessionId: session,
        sessions: [{ id: session, state: c.state, agentProfileId: c.agent }],
        ...(c.pending ? { pendingAction: c.pending } : {}),
        messages: c.messages,
      });
    }
    if (url.pathname === "/api/conversations" && init?.method === "POST") {
      const id = `card-${this.cards.size + 1}`;
      this.cards.set(id, {
        title: body.message,
        state: "RUNNING",
        agent: body.agentProfileId,
        messages: [{ id: "m1", role: "user", body: body.message }],
      });
      this.reply(id, body.message);
      return json({ conversation: { id }, message: "Started" });
    }
    if (url.pathname === "/api/conversations")
      return json({
        lane: `conversations:${P}`,
        conversations: [...this.cards].map(([id, c]) => ({
          id,
          title: c.title,
          updatedAt: "2026-11-09T00:00:00Z",
        })),
        archivedCount: 0,
      });
    if (url.pathname === "/api/lane-flows/questions" && init?.method === "POST") {
      const c = this.cards.get(body.card)!;
      c.answered = body;
      c.asks = undefined;
      // Workfloor queues the answer as the agent's next prompt: the session reads idle until it starts.
      c.state = "WAITING_FOR_INPUT";
      this.changed();
      this.reply(body.card, JSON.stringify(body.answers ?? body.reject));
      return json({});
    }
    if (url.pathname === "/api/lane-flows/questions")
      return json(
        this.cards.get(q.get("card")!)?.asks
          ? { question: this.cards.get(q.get("card")!)!.asks }
          : {},
      );
    if (url.pathname === "/api/conversation") {
      const c = this.cards.get(body.task)!;
      if (body.workflow !== (c.lane ?? `conversations:${P}`))
        return json({ error: "Not found" }, 404);
      if (body.command.kind === "send") {
        c.messages.push({ id: `m${c.messages.length + 1}`, role: "user", body: body.command.body });
        c.state = "RUNNING";
        this.reply(body.task, body.command.body);
      }
      if (body.command.kind === "stop") c.state = "IDLE";
      return json({ ok: true });
    }
    return json({ error: `no route ${url.pathname}` }, 404);
  }) as typeof fetch;
}

async function connect(
  wf: FakeWorkfloor,
  auth: () => Promise<typeof AUTH | { missing: string }> = async () => AUTH,
) {
  const provider = createWorkfloorProvider({ auth, fetch: wf.fetch });
  const connection = await provider.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "session.configure",
      "session.list",
      "session.persistence",
      "permission",
    ],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { provider, connection, events };
}

const until = async (events: ProviderEvent[], match: (e: ProviderEvent) => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const hit = events.find(match);
    if (hit) return hit;
  }
  throw new Error(`no matching event in ${ms} ms; got ${events.map((e) => e.type).join(", ")}`);
};
const turnEnded = (e: ProviderEvent) => e.type === "session.turn" && e.state !== "started";

async function open(
  connection: ProviderConnection,
  events: ProviderEvent[],
  sessionId: string,
  extra: Record<string, unknown> = {},
) {
  await connection.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true },
    history: "replay",
    ...extra,
  });
  await until(events, (e) => e.type === "session.ready" && e.sessionId === sessionId);
}

const say = (connection: ProviderConnection, sessionId: string, text: string) =>
  connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: `c-${text}`,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });

describe("the Workfloor provider", () => {
  test("is unavailable, saying how to connect, until a token is saved", async () => {
    const wf = new FakeWorkfloor();
    const { provider } = await connect(wf, async () => ({
      missing: "Open Settings, Workfloor, and paste a personal token",
    }));
    expect(await provider.status!({})).toEqual({
      available: false,
      diagnostic: "Open Settings, Workfloor, and paste a personal token",
    });
    expect(wf.requests).toEqual([]);
  });

  test("offers each project's agents as models, and reads with the token as the person", async () => {
    const wf = new FakeWorkfloor();
    const { provider, connection, events } = await connect(wf);
    expect(await provider.status!({})).toEqual({ available: true });
    await connection.send({ type: "catalog", requestId: "c1" });
    const catalog = await until(events, (e) => e.type === "catalog");
    expect(catalog).toMatchObject({
      catalog: {
        models: [{ id: `${P}:${A}`, label: "Buildy · codev", description: "claude-opus-5-5" }],
        defaultModel: `${P}:${A}`,
      },
    });
    expect(wf.requests.every((r) => r.auth === "Bearer wfpat_test")).toBe(true);
  });

  test("a first message starts a conversation, and the turn ends once the agent has answered and waits", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello world");
    const ended = await until(events, turnEnded);
    expect(ended).toMatchObject({ state: "completed", turnId: "turn-1" });
    expect(wf.requests.find((r) => r.method === "POST")).toMatchObject({
      path: "/api/conversations",
      body: { workspace: P, agentProfileId: A, message: "hello world" },
    });
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items.map((i) => i.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
    expect(items[2]).toMatchObject({ text: "Hello! You said: hello world" });
    expect(events).toContainEqual({
      type: "session.persistence",
      sessionId: "s1",
      persistence: { version: 1, data: { project: P, card: "card-1", lane: `conversations:${P}` } },
    });
  });

  test("a later message goes to the same conversation's agent session", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    events.length = 0;
    await say(connection, "s1", "two");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed", turnId: "turn-2" });
    expect(wf.requests.filter((r) => r.path === "/api/conversation").map((r) => r.body)).toEqual([
      {
        workspace: P,
        workflow: `conversations:${P}`,
        task: "card-1",
        session: "s-card-1",
        command: { kind: "send", body: "two", attachments: [], clientId: expect.any(String) },
      },
    ]);
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual(["Hello! You said: two"]);
  });

  test("reopening a conversation replays it and keeps its agent", async () => {
    const wf = new FakeWorkfloor();
    const first = await connect(wf);
    await open(first.connection, first.events, "s1");
    await say(first.connection, "s1", "hello");
    await until(first.events, turnEnded);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s2", {
      persistence: { version: 1, data: { project: P, card: "card-1" } },
    });
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items.map((i) => [i.type, "text" in i ? i.text : undefined])).toEqual([
      ["user_message", "hello"],
      ["tool_call", undefined],
      ["assistant_message", "Hello! You said: hello"],
    ]);
    expect(await until(events, (e) => e.type === "session.config")).toMatchObject({
      config: { model: `${P}:${A}` },
    });
  });

  test("lists the person's conversations as sessions to open", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    await until(events, turnEnded);
    await connection.send({ type: "sessions", requestId: "l1", cwd: "/work" });
    expect(await until(events, (e) => e.type === "sessions")).toMatchObject({
      sessions: [
        {
          persistence: { version: 1, data: { project: P, card: "card-1" } },
          cwd: "/work",
          title: "hello",
          description: "Workfloor · codev",
        },
      ],
    });
  });

  test("Stop stops Workfloor's agent and cancels the turn", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    wf.reply = () => {};
    events.length = 0;
    await say(connection, "s1", "two");
    await until(events, (e) => e.type === "session.turn" && e.state === "started");
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    expect(await until(events, turnEnded)).toMatchObject({ state: "canceled" });
    await until(events, (e) => e.type === "request.completed" && e.requestId === "i1");
    expect(wf.requests.filter((r) => r.path === "/api/conversation").at(-1)?.body).toMatchObject({
      command: { kind: "stop" },
    });
  });

  test("a failed start answers the prompt as failed with Workfloor's words", async () => {
    const wf = new FakeWorkfloor();
    const real = wf.fetch;
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/api/conversations") && init?.method === "POST"
        ? new Response(
            JSON.stringify({
              error: "Add a repository to this project before starting a conversation.",
            }),
            { status: 409 },
          )
        : real(input, init)) as typeof fetch;
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    expect(await until(events, (e) => e.type === "session.prompt_result")).toMatchObject({
      result: {
        type: "failed",
        error: { message: "Add a repository to this project before starting a conversation." },
      },
    });
  });

  test("a conversation gone from Workfloor ends the turn as failed instead of retrying forever", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.delete(card);
        wf.changed();
      }, 20);
    events.length = 0;
    await say(connection, "s1", "two");
    expect(await until(events, turnEnded)).toMatchObject({
      state: "failed",
      error: { message: "Workfloor: Not found" },
    });
  });

  test("an agent stopped in Workfloor without a word still ends the turn", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.state = "IDLE";
        wf.changed();
      }, 100);
    events.length = 0;
    await say(connection, "s1", "two");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed", turnId: "turn-2" });
  });

  test("a question the agent waits on is shown before the turn ends", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = (card) =>
      setTimeout(() => {
        const c = wf.cards.get(card)!;
        c.messages.push({ id: "q1", role: "agent", body: "Which tenant?" });
        c.pending = "question";
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "check the tenant");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items.map((i) => i.type)).toEqual(["user_message", "assistant_message", "notification"]);
    expect(items[1]).toMatchObject({ text: "Which tenant?" });
  });

  test("Stop before the first read still stops Workfloor's agent", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = () => {};
    wf.detailDelay = 200;
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    await until(events, (e) => e.type === "session.turn" && e.state === "started");
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    expect(await until(events, turnEnded)).toMatchObject({ state: "canceled" });
    await until(events, (e) => e.type === "request.completed" && e.requestId === "i1");
    expect(wf.requests.find((r) => r.path === "/api/conversation")?.body).toMatchObject({
      session: "s-card-1",
      command: { kind: "stop" },
    });
  });

  test("a Stop Workfloor fails still cancels the turn at once, and says the agent may still work", async () => {
    const wf = new FakeWorkfloor();
    const real = wf.fetch;
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/api/conversation") && String(init?.body).includes('"stop"')
        ? new Response(JSON.stringify({ error: "Workfloor is restarting" }), { status: 503 })
        : real(input, init)) as typeof fetch;
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    wf.reply = () => {};
    events.length = 0;
    await say(connection, "s1", "two");
    await until(events, (e) => e.type === "session.turn" && e.state === "started");
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    expect(await until(events, turnEnded)).toMatchObject({ state: "canceled", turnId: "turn-2" });
    expect(await until(events, (e) => e.type === "request.completed")).toMatchObject({
      requestId: "i1",
    });
    expect(
      await until(events, (e) => e.type === "timeline.item" && e.item.type === "notification"),
    ).toMatchObject({
      item: {
        message:
          "Workfloor's agent may still be working: stopping it failed (Workfloor is restarting). Stop it in Workfloor.",
      },
    });
    expect(events.filter(turnEnded)).toHaveLength(1);
  });

  test("a message to a conversation whose agent session started late reads it, instead of refusing for good", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    const real = wf.fetch;
    let blind = true;
    // Reopened while Workfloor's read names no agent session yet; it has one by the next message.
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await real(input, init);
      if (!blind || !String(input).includes("view=detail")) return answer;
      blind = false;
      const { sessionId: _, ...detail } = await answer.json();
      return new Response(JSON.stringify(detail), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { connection: later, events: laterEvents } = await connect(wf);
    await open(later, laterEvents, "s2", {
      persistence: { version: 1, data: { project: P, card: "card-1" } },
    });
    await say(later, "s2", "two");
    expect(await until(laterEvents, turnEnded)).toMatchObject({
      state: "completed",
      turnId: "turn-1",
    });
  });

  test("a Stop that finds no agent session says the agent may still be working", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = () => {};
    const real = wf.fetch;
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await real(input, init);
      if (!String(input).includes("view=detail")) return answer;
      const { sessionId: _, sessions: __, ...detail } = await answer.json();
      return new Response(JSON.stringify(detail), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    await until(events, (e) => e.type === "session.turn" && e.state === "started");
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    expect(await until(events, turnEnded)).toMatchObject({ state: "canceled" });
    expect(
      await until(events, (e) => e.type === "timeline.item" && e.item.type === "notification"),
    ).toMatchObject({
      item: {
        message:
          "Workfloor's agent may still be working: stopping it failed (Workfloor has not started its agent yet). Stop it in Workfloor.",
      },
    });
  });

  test("the agent's question is asked in Paseo, and the person's answer goes back to Workfloor by option and words", async () => {
    const wf = new FakeWorkfloor();
    const answered = wf.reply;
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "How do you want to test making a card?\n\nWhich tools?",
          context: "I ran the read-only tools.",
          questions: [
            {
              id: "card",
              title: "Test card",
              prompt: "How do you want to test making a card?",
              options: [
                { label: "Skip it", description: "Make none." },
                { label: "Handoff, you close it" },
              ],
            },
            {
              id: "scope",
              title: "Tool scope",
              prompt: "Which tools?",
              options: [{ label: "This card only" }],
            },
          ],
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "test your tools");
    const asked = await until(events, (e) => e.type === "session.permission");
    expect(asked).toMatchObject({
      request: {
        id: "ask-1",
        kind: "question",
        input: {
          questions: [
            {
              question: "How do you want to test making a card?",
              header: "Test card",
              options: [
                { label: "Skip it", description: "Make none." },
                { label: "Handoff, you close it" },
              ],
              allowOther: true,
            },
            {
              question: "Which tools?",
              header: "Tool scope",
              options: [{ label: "This card only" }],
              allowOther: true,
            },
          ],
        },
      },
    });
    expect(
      events.some(
        (e) =>
          e.type === "timeline.item" &&
          e.item.type === "assistant_message" &&
          e.item.text === "I ran the read-only tools.",
      ),
    ).toBe(true);
    expect(events.some(turnEnded)).toBe(false);
    wf.reply = answered;
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "ask-1",
      response: {
        behavior: "allow",
        updatedInput: {
          answers: { "Test card": "Handoff, you close it", "Tool scope": "only read" },
        },
      },
    });
    expect(await until(events, (e) => e.type === "session.permission_resolved")).toMatchObject({
      permissionId: "ask-1",
    });
    expect(wf.cards.get("card-1")!.answered).toEqual({
      workspace: P,
      card: "card-1",
      question: "ask-1",
      answers: [
        { questionId: "card", optionId: "2" },
        { questionId: "scope", text: "only read" },
      ],
    });
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed", turnId: "turn-1" });
    // The agent's words after the answer arrive before the turn ends, not after it.
    const end = events.findIndex(turnEnded);
    const after = events.findIndex(
      (e) =>
        e.type === "timeline.item" &&
        e.item.type === "assistant_message" &&
        e.item.text.startsWith("Hello! You said: [{"),
    );
    expect(after).toBeGreaterThan(-1);
    expect(after).toBeLessThan(end);
  });

  test("a declined question reaches Workfloor as a decline with the person's reason", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "Go on?",
          options: ["Yes", "No"],
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    expect(await until(events, (e) => e.type === "session.permission")).toMatchObject({
      request: {
        input: {
          questions: [
            {
              question: "Go on?",
              header: "Question 1",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    });
    wf.reply = () => {};
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "ask-1",
      response: { behavior: "deny", message: "not now" },
    });
    await until(events, (e) => e.type === "session.permission_resolved");
    expect(wf.cards.get("card-1")!.answered).toEqual({
      workspace: P,
      card: "card-1",
      question: "ask-1",
      reject: "not now",
    });
  });

  test("a question answered in Workfloor meanwhile is no longer asked in Paseo", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "Go on?",
          options: ["Yes"],
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    await until(events, (e) => e.type === "session.permission");
    wf.cards.get("card-1")!.asks = undefined;
    wf.changed();
    expect(await until(events, (e) => e.type === "session.permission_resolved")).toMatchObject({
      permissionId: "ask-1",
    });
  });

  test("a conversation opened while its agent waits on a question picks the turn up and asks it", async () => {
    const wf = new FakeWorkfloor();
    const first = await connect(wf);
    await open(first.connection, first.events, "s1");
    await say(first.connection, "s1", "hello");
    await until(first.events, turnEnded);
    const c = wf.cards.get("card-1")!;
    c.state = "RUNNING";
    c.asks = { id: "ask-1", kind: "agent", question: "Go on?", options: ["Yes"] };
    const { connection, events } = await connect(wf);
    await open(connection, events, "s2", {
      persistence: { version: 1, data: { project: P, card: "card-1" } },
    });
    expect(await until(events, (e) => e.type === "session.turn")).toMatchObject({
      state: "started",
    });
    expect(await until(events, (e) => e.type === "session.permission")).toMatchObject({
      request: { id: "ask-1" },
    });
  });

  test("a question Workfloor keeps for its own page (a step's go) is not asked in Paseo: the turn ends with a link", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "Run step 2?",
          options: ["Go"],
          step: { n: 2 },
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "hello");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    expect(events.some((e) => e.type === "session.permission")).toBe(false);
    expect(
      await until(events, (e) => e.type === "timeline.item" && e.item.type === "notification"),
    ).toMatchObject({
      item: {
        message: expect.stringContaining("answer it in Workfloor, https://wf.test/?project=proj-1"),
      },
    });
  });

  test("a question still waiting after a Stop is asked again on the next turn", async () => {
    const wf = new FakeWorkfloor();
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "Go on?",
          options: ["Yes"],
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, (e) => e.type === "session.permission");
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    await until(events, (e) => e.type === "request.completed" && e.requestId === "i1");
    expect(events).toContainEqual({
      type: "session.permission_resolved",
      sessionId: "s1",
      permissionId: "ask-1",
    });
    wf.reply = () => {};
    events.length = 0;
    await say(connection, "s1", "two");
    expect(await until(events, (e) => e.type === "session.permission")).toMatchObject({
      request: { id: "ask-1" },
    });
  });

  test("a read that started before the answer does not ask the answered question again", async () => {
    const wf = new FakeWorkfloor();
    const answered = wf.reply;
    wf.reply = (card) =>
      setTimeout(() => {
        wf.cards.get(card)!.asks = {
          id: "ask-1",
          kind: "agent",
          question: "Go on?",
          options: ["Yes"],
        };
        wf.changed();
      }, 20);
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, (e) => e.type === "session.permission");
    wf.reply = answered;
    // A read whose question is served now but whose conversation read lands after the answer.
    wf.detailDelay = 150;
    wf.changed();
    await Bun.sleep(20);
    await connection.send({
      type: "session.permission",
      sessionId: "s1",
      permissionId: "ask-1",
      response: { behavior: "allow", updatedInput: { answers: { "Question 1": "Yes" } } },
    });
    await until(events, turnEnded, 5000);
    expect(events.filter((e) => e.type === "session.permission")).toHaveLength(1);
  });
  test("a card's link pasted into the search lists that card, on any lane, to open", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "build-agent",
      lane: "normal-lane",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await connection.send({
      type: "sessions",
      requestId: "l1",
      cwd: "/work",
      query: `https://wf.test/?page=lanes&view=all&project=${P}&workflow=normal-lane&task=lane-card&panel=workspace`,
    });
    expect(await until(events, (e) => e.type === "sessions")).toMatchObject({
      sessions: [
        {
          persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
          cwd: "/work",
          title: "Server heap crashes",
          description: "Workfloor · codev",
        },
      ],
    });
  });

  test("an opened lane card is driven on its own lane, and a message after it moved stage goes to the new stage's agent", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "plan-agent",
      lane: "normal-lane",
      messages: [{ id: "m1", role: "agent", body: "Plan is ready." }],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    expect(
      events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : [])).map((i) => i.type),
    ).toEqual(["assistant_message"]);
    await say(connection, "s1", "one");
    await until(events, turnEnded);
    // The lane moves the card on: its Build stage's agent now holds it, in a new session.
    const card = wf.cards.get("lane-card")!;
    card.session = "s-build";
    card.agent = "build-agent";
    events.length = 0;
    await say(connection, "s1", "two");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    expect(
      wf.requests.filter((r) => r.path === "/api/conversation").map((r) => r.body),
    ).toMatchObject([
      { workflow: "normal-lane", task: "lane-card", session: "s-lane-card" },
      { workflow: "normal-lane", task: "lane-card", session: "s-build" },
    ]);
    expect(
      wf.requests
        .filter((r) => r.path.startsWith("/api/events") || r.path.includes("view=detail"))
        .every((r) => r.path.includes("workflow=normal-lane")),
    ).toBe(true);
  });
});
