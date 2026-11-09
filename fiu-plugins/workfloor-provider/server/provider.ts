import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { homedir } from "node:os";
import {
  Workfloor,
  WorkfloorError,
  type Detail,
  type Message,
  type WorkfloorAuth,
} from "./workfloor.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.list",
  "session.persistence",
] as const;

/** Engine states in which a session's agent is still at work; any other state has handed the turn back. */
const WORKING = new Set(["CREATED", "STARTING", "RUNNING"]);
const FAILED = new Set(["FAILED", "CANCELLED"]);

/** How the provider reaches Workfloor: its settings, read afresh on each use, and the fetch it calls. */
export interface WorkfloorProviderOptions {
  auth(): Promise<WorkfloorAuth | { missing: string }>;
  fetch?: typeof fetch;
}

/** A Paseo model is one of a project's agents: `<project id>:<agent profile id>`. */
const modelId = (project: string, agent: string) => `${project}:${agent}`;
function parseModel(model: string | undefined): { project: string; agent: string } | undefined {
  const [project, agent, ...rest] = (model ?? "").split(":");
  return project && agent && !rest.length ? { project, agent } : undefined;
}

interface Card {
  project: string;
  card: string;
}
interface Turn {
  id: string;
  abort: AbortController;
  replied: boolean;
}
interface Session {
  id: string;
  config: ProviderSessionConfig;
  model?: string;
  card?: Card;
  /** Workfloor's agent session on the card, once it has one. */
  workfloorSession?: string;
  seen: Set<string>;
  turns: number;
  turn?: Turn;
}

export function createWorkfloorProvider(options: WorkfloorProviderOptions): ProviderRegistration {
  const workfloor = async () => {
    const auth = await options.auth();
    if ("missing" in auth) throw new WorkfloorError(auth.missing);
    return new Workfloor(auth, options.fetch);
  };
  return {
    id: "workfloor",
    label: "Workfloor",
    description: "Your private Workfloor conversations with a project's agents",
    icon: "icon.svg",
    async status() {
      const auth = await options.auth();
      if ("missing" in auth) return { available: false, diagnostic: auth.missing };
      try {
        const projects = await new Workfloor(auth, options.fetch).projects();
        return projects.length
          ? { available: true }
          : { available: false, diagnostic: "Your Workfloor token reaches no project" };
      } catch (error) {
        return { available: false, diagnostic: `Workfloor: ${message(error)}` };
      }
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(
        workfloor,
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
      );
    },
  };
}

function createConnection(
  workfloor: () => Promise<Workfloor>,
  capabilities: readonly string[],
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  let models: Promise<ProviderModel[]> | undefined;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };
  /** Every agent of every project the token reaches, read once per connection. */
  const catalog = () => {
    models ??= (async () => {
      const wf = await workfloor();
      const projects = await wf.projects();
      const perProject = await Promise.all(
        projects.map(async (project) =>
          (await wf.agents(project.id)).map(
            (agent): ProviderModel => ({
              id: modelId(project.id, agent.id),
              label: `${agent.name} · ${project.name}`,
              ...(agent.model ? { description: agent.model } : {}),
            }),
          ),
        ),
      );
      return perProject.flat();
    })();
    models.catch(() => (models = undefined));
    return models;
  };
  const state: State = { sessions, emit, catalog, workfloor, capabilities };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      admit(input, state);
      void dispatch(input, state).catch((error: unknown) => fail(input, error, state));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) session.turn?.abort.abort();
      sessions.clear();
      listeners.clear();
    },
  };
}

interface State {
  sessions: Map<string, Session>;
  emit(event: ProviderEvent): void;
  catalog(): Promise<ProviderModel[]>;
  workfloor(): Promise<Workfloor>;
  capabilities: readonly string[];
}

function admit(input: ProviderInput, state: State): void {
  if (input.type === "session.open" && state.sessions.has(input.sessionId))
    throw new Error(`Session already exists: ${input.sessionId}`);
  if (input.type !== "session.open" && "sessionId" in input && !state.sessions.has(input.sessionId))
    throw new Error(`Unknown session: ${input.sessionId}`);
  requireProviderCapabilities(state.capabilities, input);
}

/** A request that failed after it was accepted answers as failed, by its request ID or its prompt. */
function fail(input: ProviderInput, error: unknown, state: State): void {
  const failure = { message: message(error) };
  if ("requestId" in input)
    state.emit({ type: "request.failed", requestId: input.requestId, error: failure });
  else if (input.type === "session.prompt")
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: failure },
    });
}

async function dispatch(input: ProviderInput, state: State): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const models = await state.catalog();
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: { models, modes: [], ...(models[0] ? { defaultModel: models[0].id } : {}) },
      });
      return;
    }
    case "sessions":
      await listSessions(input, state);
      return;
    case "session.open":
      await openSession(input, state);
      return;
    case "session.prompt":
      await prompt(input, state);
      return;
    case "session.configure":
      await configure(input, state);
      return;
    case "session.interrupt":
      await interrupt(input.sessionId, state);
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close": {
      state.sessions.get(input.sessionId)?.turn?.abort.abort();
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    default:
      if ("requestId" in input)
        state.emit({ type: "request.completed", requestId: input.requestId });
  }
}

const persistenceOf = (card: Card): ProviderPersistence => ({
  version: 1,
  data: { project: card.project, card: card.card },
});

function cardOf(persistence: ProviderPersistence | undefined): Card | undefined {
  const data = persistence?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { project, card } = data as Record<string, unknown>;
  return typeof project === "string" && typeof card === "string" ? { project, card } : undefined;
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  state: State,
): Promise<void> {
  const wf = await state.workfloor();
  const projects = await wf.projects();
  const lists = await Promise.all(
    projects.map(async (project) =>
      (await wf.conversations(project.id)).map((conversation) => ({
        persistence: persistenceOf({ project: project.id, card: conversation.id }),
        cwd: input.cwd ?? homedir(),
        title: conversation.title,
        description: `Workfloor · ${project.name}`,
        ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
      })),
    ),
  );
  const query = input.query?.trim().toLowerCase();
  const sessions = lists
    .flat()
    .filter((session) => !query || session.title.toLowerCase().includes(query))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, input.limit ?? undefined);
  state.emit({ type: "sessions", requestId: input.requestId, sessions });
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: State,
): Promise<void> {
  const card = cardOf(input.persistence);
  const session: Session = { id: input.sessionId, config: input.config, seen: new Set(), turns: 0 };
  let history: Message[] = [];
  if (card) {
    const detail = await (await state.workfloor()).detail(card.project, card.card);
    session.card = card;
    session.workfloorSession = detail.sessionId;
    const agent = detail.sessions?.find((s) => s.id === detail.sessionId)?.agentProfileId;
    if (agent) session.model = modelId(card.project, agent);
    history = detail.messages;
    for (const m of history) session.seen.add(m.id);
  } else {
    session.model = parseModel(input.config.model)
      ? input.config.model
      : (await state.catalog())[0]?.id;
  }
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    ...(card ? { persistence: persistenceOf(card) } : {}),
    ...(input.config.title ? { title: input.config.title } : {}),
    cwd: input.config.cwd,
  });
  state.emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: await configState(session, state),
  });
  if (input.history === "replay")
    for (const m of history) {
      const item = timelineItem(m, true);
      if (item) state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
    }
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

async function configState(session: Session, state: State): Promise<ProviderConfigState> {
  return {
    ...(session.model ? { model: session.model } : {}),
    models: await state.catalog(),
    modes: [],
    thinkingOptions: [],
    settings: [],
  };
}

async function configure(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: State,
): Promise<void> {
  const session = state.sessions.get(input.sessionId)!;
  const model = input.changes.model;
  if (model !== undefined && model !== null && model !== session.model) {
    if (session.card)
      throw new WorkfloorError(
        "A Workfloor conversation keeps its agent: start a new agent to talk to another one",
      );
    if (!parseModel(model)) throw new WorkfloorError(`${model} is not a Workfloor agent`);
    session.model = model;
  }
  state.emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: await configState(session, state),
  });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

async function prompt(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: State,
): Promise<void> {
  const session = state.sessions.get(input.sessionId)!;
  const answer = (result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]) =>
    state.emit({
      type: "session.prompt_result",
      sessionId: session.id,
      clientMessageId: input.prompt.clientMessageId,
      result,
    });
  if (input.prompt.input.type !== "message")
    return answer({ type: "failed", error: { message: "Workfloor takes messages only" } });
  if (session.turn)
    return answer({
      type: "failed",
      error: { message: "Workfloor's agent is still answering: wait for it, or stop it" },
    });
  const text = input.prompt.input.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  if (!text)
    return answer({ type: "failed", error: { message: "Write a message for Workfloor's agent" } });

  const wf = await state.workfloor();
  if (session.card) {
    if (!session.workfloorSession)
      throw new WorkfloorError(
        "This conversation's agent has not started yet: try again in a moment",
      );
    await wf.send({ ...session.card, session: session.workfloorSession }, text);
  } else {
    const picked = parseModel(session.model);
    if (!picked) throw new WorkfloorError("Pick a Workfloor agent first");
    session.card = {
      project: picked.project,
      card: await wf.start(picked.project, picked.agent, text),
    };
    state.emit({
      type: "session.persistence",
      sessionId: session.id,
      persistence: persistenceOf(session.card),
    });
  }

  session.turns += 1;
  const turn: Turn = { id: `turn-${session.turns}`, abort: new AbortController(), replied: false };
  session.turn = turn;
  state.emit({
    type: "timeline.item",
    sessionId: session.id,
    item: {
      type: "user_message",
      id: `${turn.id}-you`,
      text,
      clientMessageId: input.prompt.clientMessageId,
    },
  });
  answer({ type: "turn", turnId: turn.id });
  state.emit({ type: "session.turn", sessionId: session.id, turnId: turn.id, state: "started" });
  void follow(session, turn, wf, state);
}

/**
 * Follows a turn on Workfloor: every event its live stream sends wakes one read of the card, which
 * hands over the messages that are settled (all but the newest while the agent works) and ends the
 * turn once the agent has answered and stopped working, or when Workfloor waits on the person.
 */
async function follow(session: Session, turn: Turn, wf: Workfloor, state: State): Promise<void> {
  const card = session.card!;
  let reading = false;
  let again = false;
  const end = (outcome: "completed" | "failed" | "canceled", error?: string) => {
    if (turn.abort.signal.aborted) return;
    turn.abort.abort();
    if (session.turn === turn) session.turn = undefined;
    state.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId: turn.id,
      state: outcome,
      ...(error ? { error: { message: error } } : {}),
    });
  };
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const outcome = step(session, turn, await wf.detail(card.project, card.card), wf, state);
        if (outcome) return end(outcome.state, outcome.error);
      } while (again && !turn.abort.signal.aborted);
    } catch (error) {
      // A failed read is retried on the next event; the stream reconnects below.
      console.error(`[workfloor-provider] reading ${card.card}: ${message(error)}`);
    } finally {
      reading = false;
    }
  };
  // ponytail: the live stream is the only wake-up; a stream that stays silent leaves the turn running until Stop.
  while (!turn.abort.signal.aborted) {
    void read();
    try {
      await wf.events(
        { ...card, ...(session.workfloorSession ? { session: session.workfloorSession } : {}) },
        turn.abort.signal,
        () => void read(),
      );
    } catch (error) {
      if (turn.abort.signal.aborted) return;
      console.error(`[workfloor-provider] live stream for ${card.card}: ${message(error)}`);
    }
    if (!turn.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** One read of the card: hands over settled messages, and says how the turn ended, if it has. */
function step(
  session: Session,
  turn: Turn,
  detail: Detail,
  wf: Workfloor,
  state: State,
): { state: "completed" | "failed"; error?: string } | undefined {
  session.workfloorSession = detail.sessionId ?? session.workfloorSession;
  const current = detail.sessions?.find((s) => s.id === detail.sessionId);
  const working = !current || WORKING.has(current.state);
  const fresh = detail.messages.filter((m) => !session.seen.has(m.id));
  for (const m of working ? fresh.slice(0, -1) : fresh) {
    session.seen.add(m.id);
    const item = timelineItem(m, false);
    if (!item) continue;
    if (m.role === "agent") turn.replied = true;
    state.emit({ type: "timeline.item", sessionId: session.id, item });
  }
  if (current && FAILED.has(current.state))
    return {
      state: "failed",
      error: current.error || `Workfloor's agent stopped: ${current.state.toLowerCase()}`,
    };
  if (detail.pendingAction) {
    const what =
      detail.pendingAction === "question" ? "asks you something" : "asks for your permission";
    state.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "notification",
        id: `${turn.id}-waits`,
        level: "warning",
        message: `Workfloor's agent ${what}: answer it in Workfloor, ${wf.link(session.card!.project, session.card!.card)}`,
      },
    });
    return { state: "completed" };
  }
  return !working && turn.replied ? { state: "completed" } : undefined;
}

/** A Workfloor message as a timeline item; a person's own words are left out while live (Paseo drew them already). */
function timelineItem(m: Message, replay: boolean): ProviderTimelineItem | undefined {
  if (m.role === "user")
    return replay ? { type: "user_message", id: m.id, text: m.body } : undefined;
  if (m.tool) {
    const detail = { type: "plain_text" as const, label: m.tool.name, text: m.tool.input };
    return m.tool.status === "failed"
      ? {
          type: "tool_call",
          id: m.id,
          callId: m.id,
          name: m.tool.name,
          detail,
          status: "failed",
          error: m.body || "failed",
        }
      : {
          type: "tool_call",
          id: m.id,
          callId: m.id,
          name: m.tool.name,
          detail,
          status: m.tool.status === "cancelled" ? "canceled" : "completed",
          error: null,
        };
  }
  return m.body.trim() ? { type: "assistant_message", id: m.id, text: m.body } : undefined;
}

async function interrupt(sessionId: string, state: State): Promise<void> {
  const session = state.sessions.get(sessionId)!;
  const turn = session.turn;
  if (!turn) return;
  if (session.card && session.workfloorSession)
    await (await state.workfloor()).stop({ ...session.card, session: session.workfloorSession });
  turn.abort.abort();
  session.turn = undefined;
  state.emit({ type: "session.turn", sessionId, turnId: turn.id, state: "canceled" });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
