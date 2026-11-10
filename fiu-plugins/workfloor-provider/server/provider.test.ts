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
      /** The card view's repository and linked items. */
      code?: Record<string, unknown>;
      /** Its stage's agent never started: no session yet, and Start agent can start it (yours or not). */
      idle?: { stage: string; yours: boolean };
      /** Its agent is starting: no session yet, and nothing idle for Start agent to start. */
      starting?: boolean;
      pending?: string;
      /** The agent's `card_ask` waiting on the person, as Workfloor's questions route reads it. */
      asks?: Record<string, unknown>;
      answered?: Record<string, unknown>;
      /** Its lane archived it: every read but its read-only page's is refused. */
      archived?: boolean;
    }
  >();
  requests: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  /** Files uploaded for a message: their form fields and bytes. */
  uploads: Array<{ fields: Record<string, string>; name: string; type: string; bytes: number[] }> =
    [];
  /** Each picture's bytes by its file id, as the thumbnail route answers. */
  pictureBytes = new Map<string, Uint8Array>();
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
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? undefined);
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
      if (c.archived && q.get("archived") !== "read")
        return json({ error: "This task is not available in this project and workflow." }, 403);
      const session = c.session ?? `s-${q.get("task")}`;
      if (c.idle || c.starting)
        return json({ title: c.title, sessionId: null, sessions: [], messages: c.messages });
      return json({
        title: c.title,
        sessionId: session,
        sessions: [{ id: session, state: c.state, agentProfileId: c.agent }],
        ...(c.pending ? { pendingAction: c.pending } : {}),
        messages: c.messages,
      });
    }
    if (url.pathname === "/api/attachments" && init?.method === "POST") {
      const form = body as FormData;
      const file = form.get("file") as File;
      const fields = Object.fromEntries(
        ["workspace", "workflow", "task", "session"].map((k) => [k, String(form.get(k))]),
      );
      this.uploads.push({
        fields,
        name: file.name,
        type: file.type,
        bytes: [...new Uint8Array(await file.arrayBuffer())],
      });
      return json({
        id: `wfat_${this.uploads.length}`,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        kind: "image",
        deliveryMode: "prompt",
      });
    }
    if (url.pathname === "/api/attachments/content") {
      const bytes = this.pictureBytes.get(q.get("id")!);
      const c = this.cards.get(q.get("task")!);
      const session = c?.session ?? `s-${q.get("task")}`;
      if (!bytes || q.get("session") !== session) return json({ error: "Not found" }, 404);
      return new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } });
    }
    if (url.pathname === "/api/connection" && q.get("view") === "workflows")
      return json({ workflows: [{ id: "normal-lane" }, { id: "other-lane" }] });
    if (url.pathname === "/api/lane-flows/agent-failure") {
      const c = this.cards.get(q.get("card")!);
      return json(
        c?.idle
          ? {
              idle: {
                stageId: `stage-${c.idle.stage}`,
                stage: c.idle.stage,
                entry: 7,
                yours: c.idle.yours,
              },
            }
          : {},
      );
    }
    if (url.pathname === "/api/lane-flows/agent-start" && init?.method === "POST") {
      const c = this.cards.get(body.card)!;
      c.idle = undefined;
      c.state = "RUNNING";
      c.messages.push({ id: `m${c.messages.length + 1}`, role: "user", body: body.context });
      this.reply(body.card, body.context);
      return json({ started: true });
    }
    if (url.pathname === "/api/connection" && q.get("view") === "card") {
      const c = this.cards.get(q.get("task")!);
      if (!c || q.get("workflow") !== (c.lane ?? `conversations:${P}`))
        return json({ error: "Not found" }, 404);
      return json({ task: { id: q.get("task"), title: c.title, ...c.code } });
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

/** Paseo's API as the provider uses it: projects by remote, workspaces listed and made. */
class FakePaseo {
  projects = [
    {
      projectId: "prj_sfp",
      projectKey: "remote:github.com/flxbl-io/sfp-pro",
      projectDisplayName: "flxbl-io/sfp-pro",
      projectRootPath: "/repos/sfp-pro",
      projectKind: "git",
    },
  ];
  workspaces: Array<Record<string, unknown>> = [];
  created: Array<Record<string, unknown>> = [];
  failCreate: string | undefined;
  api = {
    projects: { list: async () => ({ requestId: "r", projects: this.projects }) },
    workspaces: {
      // Like the daemon: only the filtered project's workspaces, one per page.
      list: async (options: { filter?: { projectId?: string }; page?: { cursor?: string } }) => {
        const entries = this.workspaces.filter(
          (w) => !options.filter?.projectId || w.projectId === options.filter.projectId,
        );
        const at = Number(options.page?.cursor ?? 0);
        const hasMore = at + 1 < entries.length;
        return {
          requestId: "r",
          entries: entries.slice(at, at + 1),
          pageInfo: { nextCursor: hasMore ? String(at + 1) : null, prevCursor: null, hasMore },
        };
      },
      create: async (options: Record<string, unknown>) => {
        await Bun.sleep(20);
        if (this.failCreate) throw new Error(this.failCreate);
        this.created.push(options);
        const directory = `/worktrees/sfp-pro-${this.created.length}`;
        this.workspaces.push({
          id: `wks_${this.created.length}`,
          projectId: "prj_sfp",
          workspaceDirectory: directory,
          metadata: options.metadata,
        });
        return { id: `wks_${this.created.length}`, directory };
      },
    },
  };
}

async function connect(
  wf: FakeWorkfloor,
  auth: () => Promise<typeof AUTH | { missing: string }> = async () => AUTH,
  paseo?: FakePaseo,
) {
  const provider = createWorkfloorProvider({
    auth,
    fetch: wf.fetch,
    ...(paseo ? { paseo: paseo.api as never } : {}),
  });
  const connection = await provider.connect({
    versions: [1],
    capabilities: [
      "prompt.message",
      "prompt.image",
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
    const listed = await until(events, (e) => e.type === "sessions");
    expect(listed).toMatchObject({
      sessions: [
        {
          cwd: "/work",
          title: "hello",
          description: "Workfloor · codev",
        },
      ],
    });
    // Paseo knows an imported conversation by its persistence, saved before lanes came: it stays the same.
    expect(
      (listed as { sessions: Array<{ persistence: unknown }> }).sessions[0]!.persistence,
    ).toEqual({ version: 1, data: { project: P, card: "card-1" } });
  });

  test("a link without its lane is no card's: the search lists conversations as before", async () => {
    const wf = new FakeWorkfloor();
    // A conversation the link names, seeded rather than opened: an open session's watch would read
    // the card in the background and race the reads counted below.
    wf.cards.set("card-1", {
      title: "hello",
      state: "WAITING_FOR_INPUT",
      agent: A,
      messages: [{ id: "m1", role: "user", body: "hello" }],
    });
    const { connection, events } = await connect(wf);
    const reads = wf.requests.length;
    await connection.send({
      type: "sessions",
      requestId: "l1",
      cwd: "/work",
      query: `https://wf.test/?project=${P}&task=card-1`,
    });
    expect(await until(events, (e) => e.type === "sessions")).toMatchObject({ sessions: [] });
    const later = wf.requests.slice(reads).map((r) => r.path);
    expect(later.some((path) => path.startsWith("/api/conversations"))).toBe(true);
    expect(later.some((path) => path.includes("view=detail"))).toBe(false);
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
          description: expect.stringContaining("Workfloor · codev"),
        },
      ],
    });
  });

  test("an opened card is opened with its Workfloor title, so Paseo names the agent after it", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "build-agent",
      lane: "normal-lane",
      messages: [{ id: "m1", role: "user", body: "## Workfloor tools" }],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    expect(await until(events, (e) => e.type === "session.opened")).toMatchObject({
      title: "Server heap crashes",
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        sessionId: "s1",
        config: expect.objectContaining({ model: `${P}:build-agent` }),
      }),
    );
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
  test("a picture a card's message carries is shown inline under its words; one Workfloor can't give back is a link", async () => {
    const wf = new FakeWorkfloor();
    wf.pictureBytes.set("wfap_1", new Uint8Array([137, 80, 78, 71]));
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [
        {
          id: "m1",
          role: "agent",
          body: "The Runs page hides the runs.",
          attachments: [{ id: "wfap_1", name: "runs].png", mimeType: "image/png", size: 4 }],
        },
        {
          id: "m2",
          role: "agent",
          body: "",
          attachments: [{ id: "wfap_gone", name: "lost.png", mimeType: "image/png", size: 9 }],
        },
      ],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual([
      "The Runs page hides the runs.\n\n![runs\\].png](data:image/png;base64,iVBORw==)",
      expect.stringMatching(
        /^\[lost\.png: open it in Workfloor\]\(https:\/\/wf\.test\/\?.*task=lane-card/,
      ),
    ]);
  });

  test("a person's replayed message with a picture shows a plain note with the card's link, never the picture's bytes", async () => {
    const wf = new FakeWorkfloor();
    wf.pictureBytes.set("wfap_u", new Uint8Array([137, 80, 78, 71]));
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [
        {
          id: "m1",
          role: "user",
          body: "Look at this",
          attachments: [{ id: "wfap_u", name: "mine.png", mimeType: "image/png", size: 4 }],
        },
      ],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "user_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual([
      expect.stringMatching(
        /^Look at this\n\n1 picture, open in Workfloor: https:\/\/wf\.test\/\?.*task=lane-card/,
      ),
    ]);
    expect(texts[0]).not.toContain("data:");
    expect(wf.requests.some((r) => r.path.startsWith("/api/attachments/content"))).toBe(false);
  });

  test("a picture Workfloor can't give back yet is read again, and shown inline once it can", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [],
    });
    wf.reply = (card) => {
      const c = wf.cards.get(card)!;
      c.messages.push({
        id: "m-pic",
        role: "agent",
        body: "Here it is.",
        attachments: [{ id: "wfap_late", name: "late.png", mimeType: "image/png", size: 4 }],
      });
      wf.changed();
    };
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    await say(connection, "s1", "send the picture");
    for (
      const end = Date.now() + 3000;
      !wf.requests.some((r) => r.path.startsWith("/api/attachments/content"));
      await Bun.sleep(10)
    )
      if (Date.now() > end) throw new Error("the picture was never read");
    wf.pictureBytes.set("wfap_late", new Uint8Array([137, 80, 78, 71]));
    wf.cards.get("lane-card")!.state = "WAITING_FOR_INPUT";
    wf.changed();
    await until(events, turnEnded);
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual(["Here it is.\n\n![late.png](data:image/png;base64,iVBORw==)"]);
  });

  test("a picture of a type Workfloor never serves is a link to the card, and is never requested", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [
        {
          id: "m1",
          role: "agent",
          body: "The diagram.",
          attachments: [{ id: "wfap_svg", name: "flow.svg", mimeType: "image/svg+xml", size: 9 }],
        },
      ],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual([
      expect.stringMatching(
        /^The diagram\.\n\n\[flow\.svg: open it in Workfloor\]\(https:\/\/wf\.test\/\?.*task=lane-card/,
      ),
    ]);
    expect(wf.requests.some((r) => r.path.startsWith("/api/attachments/content"))).toBe(false);
  });

  test("a picture sent from Paseo goes up to the card's current session and with the message", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      session: "s-e2e",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c-pic",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "put this in the report" },
            {
              type: "image",
              data: Buffer.from([1, 2, 3]).toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      },
    });
    await until(events, turnEnded);
    expect(wf.uploads).toEqual([
      {
        fields: { workspace: P, workflow: "normal-lane", task: "lane-card", session: "s-e2e" },
        name: "picture-1.png",
        type: "image/png",
        bytes: [1, 2, 3],
      },
    ]);
    expect(wf.requests.find((r) => r.path === "/api/conversation")?.body).toMatchObject({
      session: "s-e2e",
      command: {
        kind: "send",
        body: "put this in the report",
        attachments: [{ id: "wfat_1", name: "picture-1.png", mimeType: "image/png" }],
      },
    });
  });

  test("a picture on a new conversation's first message is refused, saying to send words first", async () => {
    const wf = new FakeWorkfloor();
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c-first",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "image", data: "AQID", mimeType: "image/png" }],
        },
      },
    });
    expect(await until(events, (e) => e.type === "session.prompt_result")).toMatchObject({
      result: {
        type: "failed",
        error: { message: expect.stringContaining("send your words first") },
      },
    });
    expect(wf.uploads).toEqual([]);
  });

  test("between turns the card's lane is followed: a move to the next stage's agent is shown and its work followed", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [{ id: "m1", role: "agent", body: "E2E passed." }],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    events.length = 0;
    // Workfloor moves the card to Release Readiness: its agent starts, works, writes and waits.
    const card = wf.cards.get("lane-card")!;
    card.session = "s-release";
    card.agent = "shippy";
    card.state = "RUNNING";
    wf.changed();
    await Bun.sleep(30);
    card.messages.push({ id: "r1", role: "agent", body: "Release checks are next." });
    card.state = "WAITING_FOR_INPUT";
    wf.changed();
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({ model: `${P}:shippy` }),
      }),
    );
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items).toEqual([
      expect.objectContaining({
        type: "notification",
        message: "The card moved on: shippy has it now",
      }),
      expect.objectContaining({ type: "assistant_message", text: "Release checks are next." }),
    ]);
    // Nothing was sent to Workfloor: Paseo only followed the lane.
    expect(wf.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  test("a closed card is no longer watched", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    await Bun.sleep(30);
    await connection.send({ type: "session.close", requestId: "c1", sessionId: "s1" });
    await until(events, (e) => e.type === "session.closed");
    const before = wf.requests.length;
    wf.cards.get("lane-card")!.messages.push({ id: "x", role: "agent", body: "late" });
    wf.changed();
    await Bun.sleep(60);
    expect(wf.requests.length).toBe(before);
  });

  test("a closed connection watches no card", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    await Bun.sleep(30);
    await connection.close();
    const before = wf.requests.length;
    wf.cards.get("lane-card")!.messages.push({ id: "x", role: "agent", body: "late" });
    wf.changed();
    await Bun.sleep(60);
    expect(wf.requests.length).toBe(before);
  });

  test("after a Stop, an agent that still reads as working a moment starts no new turn", async () => {
    const wf = new FakeWorkfloor();
    // The agent works and writes, and is still at it when the person stops it.
    wf.reply = (card) =>
      setTimeout(() => {
        const c = wf.cards.get(card)!;
        c.messages.push({ id: `m${c.messages.length + 1}`, role: "agent", body: "Working on" });
        wf.changed();
      }, 10);
    const real = wf.fetch;
    // Workfloor takes the stop, but its agent reads as running a moment longer.
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await real(input, init);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (body?.command?.kind === "stop") {
        const c = wf.cards.get(body.task)!;
        c.state = "RUNNING";
        wf.changed();
        setTimeout(() => {
          c.state = "IDLE";
          wf.changed();
        }, 60);
      }
      return response;
    }) as typeof fetch;
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1");
    await say(connection, "s1", "one");
    await until(events, (e) => e.type === "session.turn" && e.state === "started");
    await Bun.sleep(40);
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "s1" });
    await until(events, (e) => e.type === "request.completed" && e.requestId === "i1");
    await Bun.sleep(150);
    const turns = events.flatMap((e) => (e.type === "session.turn" ? [e.state] : []));
    expect(turns).toEqual(["started", "canceled"]);
    wf.reply = () => {};
    await say(connection, "s1", "two");
    expect(
      await until(
        events,
        (e) => e.type === "session.prompt_result" && e.clientMessageId === "c-two",
      ),
    ).toMatchObject({ result: { type: "turn" } });
    await connection.close();
  });

  test("a message the person wrote in Workfloor between turns shows above the agent's reply", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "WAITING_FOR_INPUT",
      agent: "test-agent",
      lane: "normal-lane",
      messages: [{ id: "m1", role: "agent", body: "Shall I add a test?" }],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
    });
    await Bun.sleep(30);
    events.length = 0;
    const card = wf.cards.get("lane-card")!;
    card.messages.push({ id: "m2", role: "user", body: "Yes, a regression test." });
    card.state = "RUNNING";
    wf.changed();
    await Bun.sleep(30);
    card.messages.push({ id: "m3", role: "agent", body: "Added it." });
    card.state = "WAITING_FOR_INPUT";
    wf.changed();
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    const items = events.flatMap((e) => (e.type === "timeline.item" ? [e.item] : []));
    expect(items).toEqual([
      expect.objectContaining({ type: "user_message", text: "Yes, a regression test." }),
      expect.objectContaining({ type: "assistant_message", text: "Added it." }),
    ]);
    await connection.close();
  });

  /** Paseo's Import keeps a provider's row only when the search is in its words (agent-manager's match). */
  const keptByImport = (
    session: { title?: string; description?: string; cwd: string },
    query: string,
  ) =>
    [session.title, session.description, session.cwd.split("/").pop()].some((v) =>
      v?.toLowerCase().includes(query.trim().toLowerCase()),
    );

  test("a card found by its link survives Import's own match on the search words", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Server heap crashes",
      state: "IDLE",
      agent: "build-agent",
      lane: "normal-lane",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    const link = `https://wf.test/?page=lanes&project=${P}&workflow=normal-lane&task=lane-card`;
    await connection.send({ type: "sessions", requestId: "l1", cwd: "/work", query: link });
    const listed = (await until(events, (e) => e.type === "sessions")) as Extract<
      ProviderEvent,
      { type: "sessions" }
    >;
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]!.exact).toBe(true);
    expect(keptByImport(listed.sessions[0]!, link)).toBe(true);
  });

  test("a short card link (/c/<card>) is found on the lane that shows it", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Scratch pools run past 6 hours",
      state: "IDLE",
      agent: "plan-agent",
      lane: "normal-lane",
      messages: [],
    });
    const { connection, events } = await connect(wf);
    const link = "https://wf.test/c/lane-card";
    await connection.send({ type: "sessions", requestId: "l1", cwd: "/work", query: link });
    const listed = (await until(events, (e) => e.type === "sessions")) as Extract<
      ProviderEvent,
      { type: "sessions" }
    >;
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        persistence: { version: 1, data: { project: P, card: "lane-card", lane: "normal-lane" } },
        title: "Scratch pools run past 6 hours",
        exact: true,
      }),
    ]);
    expect(keptByImport(listed.sessions[0]!, link)).toBe(true);
  });

  test("a short link to a conversation is found on the Conversations lane; an unknown card lists nothing", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("conv-card", { title: "hello world", state: "IDLE", agent: A, messages: [] });
    const { connection, events } = await connect(wf);
    await connection.send({
      type: "sessions",
      requestId: "l1",
      cwd: "/work",
      query: "https://wf.test/c/conv-card",
    });
    const listed = (await until(
      events,
      (e) => e.type === "sessions" && e.requestId === "l1",
    )) as Extract<ProviderEvent, { type: "sessions" }>;
    expect(listed.sessions[0]?.persistence).toEqual({
      version: 1,
      data: { project: P, card: "conv-card" },
    });
    await connection.send({
      type: "sessions",
      requestId: "l2",
      cwd: "/work",
      query: "https://wf.test/c/nope",
    });
    const none = (await until(
      events,
      (e) => e.type === "sessions" && e.requestId === "l2",
    )) as Extract<ProviderEvent, { type: "sessions" }>;
    expect(none.sessions).toEqual([]);
  });

  test("a short link whose lane read fails lists the failure, not an empty result", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", {
      title: "Scratch pools run past 6 hours",
      state: "IDLE",
      agent: "plan-agent",
      lane: "normal-lane",
      messages: [],
    });
    const answer = wf.fetch;
    wf.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const q = new URL(String(input)).searchParams;
      return q.get("view") === "detail" && q.get("workflow") === "other-lane"
        ? new Response(JSON.stringify({ error: "Internal error" }), { status: 500 })
        : answer(input, init);
    }) as typeof fetch;
    const { connection, events } = await connect(wf);
    await connection.send({
      type: "sessions",
      requestId: "l1",
      cwd: "/work",
      query: "https://wf.test/c/lane-card",
    });
    await until(events, (e) => e.type === "request.failed" || e.type === "sessions");
    expect(events.filter((e) => e.type === "request.failed" || e.type === "sessions")).toEqual([
      expect.objectContaining({ type: "request.failed", requestId: "l1" }),
    ]);
  });

  test("a message to an imported card whose stage's agent never started starts it, with the message", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("plan-card", {
      title: "Scratch pools run past 6 hours",
      state: "IDLE",
      agent: "planny",
      lane: "normal-lane",
      idle: { stage: "Plan", yours: true },
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "plan-card", lane: "normal-lane" } },
    });
    await say(connection, "s1", "plan the 6h fix");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
    expect(wf.requests.find((r) => r.path === "/api/lane-flows/agent-start")?.body).toEqual({
      workspace: P,
      card: "plan-card",
      stage: "stage-Plan",
      entry: 7,
      context: "plan the 6h fix",
    });
    const texts = events.flatMap((e) =>
      e.type === "timeline.item" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toContain("Hello! You said: plan the 6h fix");
  });

  test("a card with no agent that isn't the person's to start says so, with its link, and starts nothing", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("plan-card", {
      title: "Scratch pools run past 6 hours",
      state: "IDLE",
      agent: "planny",
      lane: "normal-lane",
      idle: { stage: "Plan", yours: false },
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "plan-card", lane: "normal-lane" } },
    });
    await say(connection, "s1", "plan it");
    expect(await until(events, (e) => e.type === "session.prompt_result")).toMatchObject({
      result: {
        type: "failed",
        error: {
          message: expect.stringMatching(
            /^No agent is on this card in Plan, and only its assignee.*task=plan-card/,
          ),
        },
      },
    });
    expect(wf.requests.some((r) => r.path === "/api/lane-flows/agent-start")).toBe(false);
  });

  test("an archived card opens read only with its history, is not watched, and a message says to restore it", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("done-card", {
      title: "Scratch pools run past 6 hours",
      state: "COMPLETED",
      agent: "rr-agent",
      lane: "normal-lane",
      archived: true,
      messages: [{ id: "m1", role: "agent", body: "Released to production." }],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "done-card", lane: "normal-lane" } },
    });
    expect(
      events
        .flatMap((e) => (e.type === "timeline.item" ? [e.item] : []))
        .map((i) => [i.type, "text" in i ? i.text : undefined]),
    ).toEqual([["assistant_message", "Released to production."]]);
    await say(connection, "s1", "anything left?");
    expect(await until(events, (e) => e.type === "session.prompt_result")).toMatchObject({
      result: {
        type: "failed",
        error: {
          message: expect.stringMatching(/^This card is archived in Workfloor.*task=done-card/),
        },
      },
    });
    expect(wf.requests.some((r) => r.path === "/api/conversation")).toBe(false);
    expect(wf.requests.some((r) => r.path.startsWith("/api/events"))).toBe(false);
  });

  test("a card restored to its board after it opened archived takes messages again", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("done-card", {
      title: "Scratch pools run past 6 hours",
      state: "WAITING_FOR_INPUT",
      agent: "rr-agent",
      lane: "normal-lane",
      archived: true,
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "done-card", lane: "normal-lane" } },
    });
    wf.cards.get("done-card")!.archived = false;
    await say(connection, "s1", "one more thing");
    expect(await until(events, turnEnded)).toMatchObject({ state: "completed" });
  });

  test("a card whose agent is still starting asks to try again in a moment, with its link", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("plan-card", {
      title: "Scratch pools run past 6 hours",
      state: "IDLE",
      agent: "planny",
      lane: "normal-lane",
      starting: true,
      messages: [],
    });
    const { connection, events } = await connect(wf);
    await open(connection, events, "s1", {
      persistence: { version: 1, data: { project: P, card: "plan-card", lane: "normal-lane" } },
    });
    await say(connection, "s1", "plan it");
    expect(await until(events, (e) => e.type === "session.prompt_result")).toMatchObject({
      result: {
        type: "failed",
        error: {
          message: expect.stringMatching(/try again in a moment.*task=plan-card/),
        },
      },
    });
    expect(wf.requests.some((r) => r.path === "/api/lane-flows/agent-start")).toBe(false);
  });
  const LINK = `https://wf.test/?page=lanes&project=${P}&workflow=normal-lane&task=lane-card`;
  const laneCard = (code: Record<string, unknown>) => ({
    title: "Server heap crashes",
    state: "IDLE",
    agent: "build-agent",
    lane: "normal-lane",
    messages: [],
    code,
  });
  const ON_PR = {
    repository: "flxbl-io/sfp-pro",
    externalItems: [
      { kind: "issue", repository: "flxbl-io/sfp-pro", number: 3044, state: null },
      { kind: "pull_request", repository: "flxbl-io/sfp-pro", number: 3072, state: "open" },
    ],
  };
  const listLink = async (connection: ProviderConnection, events: ProviderEvent[], id: string) => {
    await connection.send({ type: "sessions", requestId: id, cwd: "/here", query: LINK });
    return (await until(events, (e) => e.type === "sessions" && e.requestId === id)) as Extract<
      ProviderEvent,
      { type: "sessions" }
    >;
  };

  test("a linked card is listed in a worktree of its repository on its open pull request, made once", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", laneCard(ON_PR));
    const paseo = new FakePaseo();
    const { connection, events } = await connect(wf, undefined, paseo);
    // Two searches at once (a pasted link searched twice) make one worktree.
    const [first, second] = await Promise.all([
      listLink(connection, events, "l1"),
      listLink(connection, events, "l2"),
    ]);
    const third = await listLink(connection, events, "l3");
    for (const listed of [first, second, third])
      expect(listed.sessions.map((s) => s.cwd)).toEqual(["/worktrees/sfp-pro-1"]);
    expect(paseo.created).toEqual([
      {
        source: {
          kind: "worktree",
          projectId: "prj_sfp",
          action: "checkout",
          checkoutSource: { kind: "change_request", number: 3072 },
        },
        title: "Server heap crashes",
        metadata: { workfloorCard: `${P}/lane-card` },
      },
    ]);
  });

  test("a worktree already on the card's pull request is reused", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", laneCard(ON_PR));
    const paseo = new FakePaseo();
    paseo.workspaces.push(
      { id: "wks_other", projectId: "prj_other", workspaceDirectory: "/other", metadata: {} },
      { id: "wks_main", projectId: "prj_sfp", workspaceDirectory: "/repos/sfp-pro", metadata: {} },
    );
    paseo.workspaces.push({
      id: "wks_mine",
      projectId: "prj_sfp",
      workspaceDirectory: "/worktrees/fix-3044",
      metadata: {},
      githubRuntime: {
        pullRequest: { number: 3072, url: "https://github.com/flxbl-io/sfp-pro/pull/3072" },
      },
    });
    const { connection, events } = await connect(wf, undefined, paseo);
    expect((await listLink(connection, events, "l1")).sessions[0]?.cwd).toBe("/worktrees/fix-3044");
    expect(paseo.created).toEqual([]);
  });

  test("a worktree that can't be made still lists the card, in its project's checkout, saying why", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", laneCard(ON_PR));
    const paseo = new FakePaseo();
    paseo.failCreate = "gh: not logged in";
    const { connection, events } = await connect(wf, undefined, paseo);
    const listed = await listLink(connection, events, "l1");
    expect(listed.sessions.map((s) => [s.cwd, s.description])).toEqual([
      ["/repos/sfp-pro", `Workfloor · codev · worktree not made: gh: not logged in · ${LINK}`],
    ]);
  });

  test("a card with no open pull request works in its project's checkout; one Paseo has no project for stays where Import is", async () => {
    const wf = new FakeWorkfloor();
    wf.cards.set("lane-card", laneCard({ repository: "flxbl-io/sfp-pro", externalItems: [] }));
    const paseo = new FakePaseo();
    const { connection, events } = await connect(wf, undefined, paseo);
    expect((await listLink(connection, events, "l1")).sessions[0]?.cwd).toBe("/repos/sfp-pro");
    wf.cards.set("lane-card", laneCard({ ...ON_PR, repository: "flxbl-io/other" }));
    expect((await listLink(connection, events, "l2")).sessions[0]?.cwd).toBe("/here");
    expect(paseo.created).toEqual([]);
  });
});
