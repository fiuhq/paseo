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
    { title: string; state: string; messages: Array<Record<string, unknown>>; agent: string }
  >();
  requests: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  /** What the agent does with a message: by default it works a moment, then answers and waits. */
  reply = (card: string, words: string) => {
    setTimeout(() => {
      const c = this.cards.get(card)!;
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
      const c = this.cards.get(q.get("task")!);
      if (!c) return json({ error: "Not found" }, 404);
      return json({
        sessionId: `s-${q.get("task")}`,
        sessions: [{ id: `s-${q.get("task")}`, state: c.state, agentProfileId: c.agent }],
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
    if (url.pathname === "/api/conversation") {
      const c = this.cards.get(body.task)!;
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
    capabilities: ["prompt.message", "session.configure", "session.list", "session.persistence"],
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
      persistence: { version: 1, data: { project: P, card: "card-1" } },
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
    expect(wf.requests.at(-1)?.body).toMatchObject({ command: { kind: "stop" } });
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
});
