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
  cardOfLink,
  lane,
  type Attachment,
  type CardRef,
  type Detail,
  type Message,
  type WaitingQuestion,
  type WorkfloorAuth,
} from "./workfloor.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
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

/** A conversation, or a card on one of the project's assembly lanes. */
type Card = CardRef;
interface Turn {
  id: string;
  abort: AbortController;
  replied: boolean;
  /** Its agent was seen at work: a turn whose agent stops without a word (Stop in Workfloor) still ends. */
  worked: boolean;
  /** The person's words Paseo sent and drew for this turn, until Workfloor's copy is read. */
  sent?: string;
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
  /**
   * Until the next turn, what a Stop left on the card, which the watch starts no turn for: the
   * agent's question it stopped on, and the messages the card held once the stop landed.
   */
  stopped?: { question?: string; messages?: ReadonlySet<string> };
  /** A message on its way to Workfloor: the turn it starts follows the card, not the watch. */
  sending?: boolean;
  /** Between turns, the watch on the card that follows its lane: stage moves, a new agent's work. */
  watch?: AbortController;
  /** The agent's question raised in Paseo: its Workfloor id, and each question by the header Paseo answers it under. */
  asked?: { id: string; keys: Array<{ header: string; questionId: string; options: string[] }> };
  /** The question last answered here: a read that started before the answer never asks it again. */
  answered?: string;
  /** Each picture a message carries, as the Markdown image shown for it, by its Workfloor file id. */
  pictures: Map<string, string>;
  /** Workfloor's agent being stopped after a Stop: the next message waits for it, so it is never the one stopped. */
  stopping?: Promise<void>;
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
      for (const session of sessions.values()) {
        session.turn?.abort.abort();
        unwatch(session);
      }
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
  else if (input.type === "session.permission")
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: {
        type: "notification",
        id: `${input.permissionId}-unanswered`,
        level: "error",
        message: `Your answer did not reach Workfloor: ${failure.message}`,
      },
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
    case "session.permission":
      await answerQuestion(input, state);
      return;
    case "session.interrupt":
      await interrupt(input.sessionId, state);
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close": {
      const closing = state.sessions.get(input.sessionId);
      closing?.turn?.abort.abort();
      if (closing) unwatch(closing);
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
  data: {
    project: card.project,
    card: card.card,
    ...(card.lane !== lane(card.project) ? { lane: card.lane } : {}),
  },
});

/** A saved card; one saved before lanes came is a conversation. */
function cardOf(persistence: ProviderPersistence | undefined): Card | undefined {
  const data = persistence?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { project, card, lane: saved } = data as Record<string, unknown>;
  if (typeof project !== "string" || typeof card !== "string") return undefined;
  return { project, card, lane: typeof saved === "string" ? saved : lane(project) };
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  state: State,
): Promise<void> {
  const wf = await state.workfloor();
  const projects = await wf.projects();
  // A Workfloor card's link, pasted into the search, lists that card: any lane's, to open and drive here.
  const linked = cardOfLink(input.query);
  if (linked) {
    const detail = await wf.detail(linked);
    const project = projects.find((p) => p.id === linked.project);
    const sessions = [
      {
        persistence: persistenceOf(linked),
        cwd: input.cwd ?? homedir(),
        title: detail.title || linked.card,
        description: `Workfloor · ${project?.name ?? linked.project}`,
      },
    ];
    state.emit({ type: "sessions", requestId: input.requestId, sessions });
    return;
  }
  const lists = await Promise.all(
    projects.map(async (project) =>
      (await wf.conversations(project.id)).map((conversation) => ({
        persistence: persistenceOf({
          project: project.id,
          card: conversation.id,
          lane: lane(project.id),
        }),
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
  const session: Session = {
    id: input.sessionId,
    config: input.config,
    seen: new Set(),
    turns: 0,
    pictures: new Map(),
  };
  let history: Message[] = [];
  let busy = false;
  // The card's name in Workfloor: Paseo names an imported agent with it.
  let title = input.config.title;
  const wf = card ? await state.workfloor() : undefined;
  if (card && wf) {
    const [detail, waiting] = await Promise.all([
      wf.detail(card),
      wf.question(card.project, card.card),
    ]);
    const current = detail.sessions?.find((s) => s.id === detail.sessionId);
    // Opened while its agent still works or waits on a question: the turn is picked up and followed.
    busy = (!!current && WORKING.has(current.state)) || answerable(waiting);
    session.card = card;
    session.workfloorSession = detail.sessionId;
    const agent = detail.sessions?.find((s) => s.id === detail.sessionId)?.agentProfileId;
    if (agent) session.model = modelId(card.project, agent);
    history = detail.messages;
    for (const m of history) session.seen.add(m.id);
    title ||= detail.title;
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
    ...(title ? { title } : {}),
    cwd: input.config.cwd,
  });
  state.emit({
    type: "session.config",
    sessionId: input.sessionId,
    config: await configState(session, state),
  });
  const shown =
    input.history === "replay" && card && wf
      ? await pictures(session, wf, { ...card, session: session.workfloorSession }, history)
      : new Map<string, string>();
  if (input.history === "replay")
    for (const m of history) {
      const item = timelineItem(m, shown);
      if (item) state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
    }
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  if (busy && wf) startTurn(session, newTurn(session), wf, state);
  else watch(session, state);
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
        "A Workfloor card keeps its agents: start a new agent to talk to another one",
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
  if (session.turn || session.sending)
    return answer({
      type: "failed",
      error: { message: "Workfloor's agent is still answering: wait for it, or stop it" },
    });
  const text = input.prompt.input.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  const images = input.prompt.input.content.flatMap((part) =>
    part.type === "image" ? [part] : [],
  );
  if (!text && !images.length)
    return answer({ type: "failed", error: { message: "Write a message for Workfloor's agent" } });
  if (images.length && !session.card)
    return answer({
      type: "failed",
      error: {
        message:
          "Workfloor takes pictures once the conversation has started: send your words first, then the pictures",
      },
    });

  session.sending = true;
  unwatch(session);
  try {
    const wf = await state.workfloor();
    await session.stopping;
    if (session.card) {
      // The card's agent now: its session may have started, or the card moved on to its next
      // stage's agent, since this Paseo session last read it.
      await track(session, await wf.detail(session.card), state);
      if (!session.workfloorSession)
        throw new WorkfloorError("This card's agent has not started yet: try again in a moment");
      const scope = { ...session.card, session: session.workfloorSession };
      // Each picture goes up to the card's current session first, as Workfloor's composer sends
      // them.
      const attachments = await Promise.all(
        images.map((image, i) =>
          wf.upload(scope, {
            name: `picture-${i + 1}.${image.mimeType.split("/")[1] ?? "png"}`,
            mimeType: image.mimeType,
            bytes: Buffer.from(image.data, "base64"),
          }),
        ),
      );
      await wf.send(scope, text, attachments);
    } else {
      const picked = parseModel(session.model);
      if (!picked) throw new WorkfloorError("Pick a Workfloor agent first");
      session.card = {
        project: picked.project,
        card: await wf.start(picked.project, picked.agent, text),
        lane: lane(picked.project),
      };
      state.emit({
        type: "session.persistence",
        sessionId: session.id,
        persistence: persistenceOf(session.card),
      });
    }

    const turn = newTurn(session);
    turn.sent = text;
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
    startTurn(session, turn, wf, state);
  } finally {
    session.sending = false;
    watch(session, state);
  }
}

function newTurn(session: Session): Turn {
  unwatch(session);
  session.stopped = undefined;
  session.turns += 1;
  const turn: Turn = {
    id: `turn-${session.turns}`,
    abort: new AbortController(),
    replied: false,
    worked: false,
  };
  session.turn = turn;
  return turn;
}

function startTurn(session: Session, turn: Turn, wf: Workfloor, state: State): void {
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
    // A question still waiting is asked again next turn.
    forget(session, state);
    state.emit({
      type: "session.turn",
      sessionId: session.id,
      turnId: turn.id,
      state: outcome,
      ...(error ? { error: { message: error } } : {}),
    });
    watch(session, state);
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
        const [detail, waiting] = await Promise.all([
          wf.detail(card),
          wf.question(card.project, card.card),
        ]);
        await track(session, detail, state);
        const shown = await pictures(
          session,
          wf,
          { ...card, session: detail.sessionId },
          detail.messages.filter((m) => !session.seen.has(m.id)),
        );
        const outcome = step(session, turn, detail, waiting, wf, state, shown);
        if (outcome) return end(outcome.state, outcome.error);
      } while (again && !turn.abort.signal.aborted);
    } catch (error) {
      if (gone(error)) return end("failed", `Workfloor: ${message(error)}`);
      // Any other failed read is retried on the next event; the stream reconnects below.
      console.error(`[workfloor-provider] reading ${card.card}: ${message(error)}`);
    } finally {
      reading = false;
    }
  };
  // ponytail: the live stream is the only wake-up; a stream that stays silent leaves the turn running until Stop.
  // A token Workfloor no longer takes, or a conversation that is gone, ends the turn instead of retrying forever.
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
      if (gone(error)) return end("failed", `Workfloor: ${message(error)}`);
      console.error(`[workfloor-provider] live stream for ${card.card}: ${message(error)}`);
    }
    if (!turn.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Between turns, keeps following the card's lane, as Workfloor's page does: each event of its live
 * stream wakes one read, which shows the agent that has the card now, and starts a turn to follow
 * it when that agent works, asks, or has written since Paseo last read the card.
 */
function watch(session: Session, state: State): void {
  if (
    !session.card ||
    session.turn ||
    session.watch ||
    session.sending ||
    state.sessions.get(session.id) !== session
  )
    return;
  const abort = new AbortController();
  session.watch = abort;
  const card = session.card;
  const end = () => {
    if (session.watch === abort) unwatch(session);
  };
  void (async () => {
    const wf = await state.workfloor();
    let reading = false;
    let again = false;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        do {
          again = false;
          const [detail, waiting] = await Promise.all([
            wf.detail(card),
            wf.question(card.project, card.card),
          ]);
          if (abort.signal.aborted) return;
          await track(session, detail, state);
          if (abort.signal.aborted) return;
          const current = detail.sessions?.find((s) => s.id === detail.sessionId);
          // After a Stop, the agent it stopped may still read as working a moment, and the message
          // its turn held back is no news: only a new message or another question starts a turn.
          const stopped = session.stopped;
          if (stopped) stopped.messages ??= new Set(detail.messages.map((m) => m.id));
          const fresh = detail.messages.some(
            (m) => !session.seen.has(m.id) && !stopped?.messages?.has(m.id),
          );
          // While Workfloor waits on the person for what only its page takes, a turn would just end
          // with the same link again: follow only what the agent writes then.
          const held = !!detail.pendingAction || (!!waiting && !answerable(waiting));
          const working = !stopped && !!current && WORKING.has(current.state);
          const asks = answerable(waiting) && waiting.id !== stopped?.question;
          if (asks || fresh || (working && !held)) {
            startTurn(session, newTurn(session), wf, state);
            return;
          }
        } while (again && !abort.signal.aborted);
      } catch (error) {
        console.error(`[workfloor-provider] watching ${card.card}: ${message(error)}`);
      } finally {
        reading = false;
      }
    };
    while (!abort.signal.aborted) {
      void read();
      try {
        await wf.events(card, abort.signal, () => void read());
      } catch (error) {
        if (abort.signal.aborted) return;
        // A token Workfloor no longer takes, or a card that is gone: nothing left to follow.
        if (gone(error)) return end();
        console.error(`[workfloor-provider] live stream for ${card.card}: ${message(error)}`);
      }
      if (!abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })().catch((error: unknown) => {
    console.error(`[workfloor-provider] watching ${card.card}: ${message(error)}`);
    end();
  });
}

function unwatch(session: Session): void {
  session.watch?.abort();
  session.watch = undefined;
}

/** The card's agent now, which the lane moves on stage by stage, shown as the session's model. */
async function track(session: Session, detail: Detail, state: State): Promise<void> {
  session.workfloorSession = detail.sessionId ?? session.workfloorSession;
  const agent = detail.sessions?.find((s) => s.id === detail.sessionId)?.agentProfileId;
  if (!agent || !session.card) return;
  const model = modelId(session.card.project, agent);
  if (model === session.model) return;
  try {
    const config = await configState({ ...session, model }, state);
    const moved = session.model !== undefined;
    session.model = model;
    state.emit({ type: "session.config", sessionId: session.id, config });
    // The lane moved the card on to another stage's agent: say so where the person reads.
    if (moved && detail.sessionId) {
      const label = config.models.find((m) => m.id === model)?.label ?? agent;
      state.emit({
        type: "timeline.item",
        sessionId: session.id,
        item: {
          type: "notification",
          id: `moved-${detail.sessionId}`,
          level: "info",
          message: `The card moved on: ${label} has it now`,
        },
      });
    }
  } catch (error) {
    console.error(`[workfloor-provider] showing ${session.card.card}'s agent: ${message(error)}`);
  }
}

/** One read of the card: hands over settled messages, and says how the turn ended, if it has. */
function step(
  session: Session,
  turn: Turn,
  detail: Detail,
  waiting: WaitingQuestion | undefined,
  wf: Workfloor,
  state: State,
  shown: ReadonlyMap<string, string>,
): { state: "completed" | "failed"; error?: string } | undefined {
  const current = detail.sessions?.find((s) => s.id === detail.sessionId);
  const working = !current || WORKING.has(current.state);
  if (current && WORKING.has(current.state)) turn.worked = true;
  const fresh = detail.messages.filter((m) => !session.seen.has(m.id));
  // The newest message may still be growing while the agent works, unless Workfloor waits on the
  // person: then it is the question they must see.
  const hold = working && !detail.pendingAction && !waiting;
  for (const m of hold ? fresh.slice(0, -1) : fresh) {
    session.seen.add(m.id);
    // Paseo drew the message it sent this turn already; one written in Workfloor shows.
    if (m.role === "user" && turn.sent !== undefined && m.body.trim() === turn.sent) {
      turn.sent = undefined;
      continue;
    }
    const item = timelineItem(m, shown);
    if (!item) continue;
    if (m.role === "agent") turn.replied = true;
    state.emit({ type: "timeline.item", sessionId: session.id, item });
  }
  if (current && FAILED.has(current.state))
    return {
      state: "failed",
      error: current.error || `Workfloor's agent stopped: ${current.state.toLowerCase()}`,
    };
  // The agent's own question is answered here, in Paseo, while the turn stays open; one answered
  // in Workfloor meanwhile is no longer asked.
  if (answerable(waiting)) {
    if (session.asked?.id !== waiting.id && session.answered !== waiting.id)
      raise(session, waiting, state);
    return undefined;
  }
  if (session.asked) {
    state.emit({
      type: "session.permission_resolved",
      sessionId: session.id,
      permissionId: session.asked.id,
    });
    session.asked = undefined;
  }
  // A lane's own ask or approval, or a permission request, is Workfloor's alone to take.
  if (detail.pendingAction || waiting) {
    const what =
      detail.pendingAction === "permission" ? "asks for your permission" : "asks you something";
    state.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: {
        type: "notification",
        id: `${turn.id}-waits`,
        level: "warning",
        message: `Workfloor's agent ${what}: answer it in Workfloor, ${wf.link(session.card!)}`,
      },
    });
    return { state: "completed" };
  }
  return !working && (turn.replied || turn.worked) ? { state: "completed" } : undefined;
}

/** A Workfloor message as a timeline item, its pictures shown under its words. */
function timelineItem(
  m: Message,
  shown: ReadonlyMap<string, string>,
): ProviderTimelineItem | undefined {
  const text = [m.body.trim(), shown.get(m.id)].filter(Boolean).join("\n\n");
  if (m.role === "user") return { type: "user_message", id: m.id, text };
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
  return text ? { type: "assistant_message", id: m.id, text } : undefined;
}

/** How many pictures are read from Workfloor at once. */
const PICTURE_READS = 4;
/** The picture types Workfloor's thumbnail route serves; any other is a link to the card. */
const SERVED_PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Workfloor's answers to a picture too large (413) or of a type it never serves (415). */
const FINAL_STATUSES = new Set([413, 415]);

/**
 * What shows for the pictures these messages carry, by message id. An agent's are read from
 * Workfloor and shown inline (a `data:` image, which Paseo renders on every client); one Workfloor
 * cannot give back is a link to the card, read again next time unless it never can be. A person's
 * message is plain text in Paseo, so its pictures are a note with the card's link, never read.
 */
async function pictures(
  session: Session,
  wf: Workfloor,
  scope: CardRef & { session?: string },
  messages: readonly Message[],
): Promise<Map<string, string>> {
  const shown = new Map<string, string>();
  const add = (id: string, text: string) =>
    shown.set(id, [shown.get(id), text].filter(Boolean).join("\n\n"));
  const wanted: Array<{ messageId: string; file: Attachment }> = [];
  for (const m of messages) {
    const files = (m.attachments ?? []).filter((a) => a.mimeType.startsWith("image/"));
    if (!files.length) continue;
    if (m.role === "user")
      add(
        m.id,
        `${files.length} picture${files.length === 1 ? "" : "s"}, open in Workfloor: ${wf.link(scope)}`,
      );
    else if (!m.tool) wanted.push(...files.map((file) => ({ messageId: m.id, file })));
  }
  const failed = new Map<string, string>();
  // ponytail: whole-picture data: URLs in the timeline (Workfloor caps a file at 10 MiB); a cached file served to Paseo if timelines grow too heavy.
  for (let at = 0; at < wanted.length; at += PICTURE_READS)
    await Promise.all(
      wanted.slice(at, at + PICTURE_READS).map(async ({ messageId, file }) => {
        if (session.pictures.has(file.id)) return;
        const link = `[${markdownText(file.name)}: open it in Workfloor](${wf.link(scope)})`;
        if (!SERVED_PICTURES.has(file.mimeType)) {
          failed.set(file.id, link);
          return;
        }
        try {
          if (!scope.session) throw new WorkfloorError("the card has no agent session yet");
          const { bytes, type } = await wf.picture(
            { ...scope, session: scope.session, message: messageId },
            file.id,
          );
          session.pictures.set(
            file.id,
            `![${markdownText(file.name)}](data:${type};base64,${Buffer.from(bytes).toString("base64")})`,
          );
        } catch (error) {
          console.error(`[workfloor-provider] picture ${file.id}: ${message(error)}`);
          const final = error instanceof WorkfloorError && FINAL_STATUSES.has(error.status ?? 0);
          (final ? session.pictures : failed).set(file.id, link);
        }
      }),
    );
  for (const { messageId, file } of wanted)
    add(messageId, session.pictures.get(file.id) ?? failed.get(file.id) ?? "");
  return shown;
}

/** A name as Markdown link text: on one line, its brackets and backslashes taken literally. */
function markdownText(name: string): string {
  return name.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\[\]]/g, "\\$&");
}

/** Raises the agent's `card_ask` as a Paseo question: its context in the chat, each question with its options. */
function raise(session: Session, waiting: WaitingQuestion, state: State): void {
  const asks: NonNullable<WaitingQuestion["questions"]> = waiting.questions?.length
    ? waiting.questions
    : [{ prompt: waiting.question, options: (waiting.options ?? []).map((label) => ({ label })) }];
  const headers = new Set<string>();
  const keys = asks.map((q, i) => {
    let header = (q.title || `Question ${i + 1}`).trim();
    if (headers.has(header)) header = `${header} (${i + 1})`;
    headers.add(header);
    // Workfloor keys a lone question by the ask's id, several by the agent's own ids (#950).
    const questionId = asks.length === 1 ? waiting.id : ("id" in q && q.id) || `q${i + 1}`;
    return { header, questionId, options: (q.options ?? []).map((o) => o.label) };
  });
  session.asked = { id: waiting.id, keys };
  if (waiting.context?.trim())
    state.emit({
      type: "timeline.item",
      sessionId: session.id,
      item: { type: "assistant_message", id: `${waiting.id}-context`, text: waiting.context },
    });
  state.emit({
    type: "session.permission",
    sessionId: session.id,
    request: {
      id: waiting.id,
      name: "question",
      kind: "question",
      title: "Workfloor's agent asks",
      input: {
        questions: asks.map((q, i) => ({
          question: q.prompt,
          header: keys[i]!.header,
          options: (q.options ?? []).map((o) => ({
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
          })),
          allowOther: true,
        })),
      },
    },
  });
}

/** Sends the person's answer, or their decline, to the question Workfloor's agent waits on. */
async function answerQuestion(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  state: State,
): Promise<void> {
  const session = state.sessions.get(input.sessionId)!;
  const asked = session.asked;
  if (!asked || asked.id !== input.permissionId || !session.card)
    throw new WorkfloorError("That question is no longer waiting in Workfloor");
  const wf = await state.workfloor();
  const response = input.response;
  if (response.behavior === "deny") {
    await wf.answer(session.card.project, session.card.card, asked.id, {
      reject: response.message ?? "",
    });
  } else {
    const given = response.updatedInput?.answers;
    const record = given && typeof given === "object" && !Array.isArray(given) ? given : {};
    const answers = asked.keys.map((key) => {
      const value = record[key.header];
      const words = typeof value === "string" ? value.trim() : "";
      const n = key.options.indexOf(words);
      return n >= 0
        ? { questionId: key.questionId, optionId: String(n + 1) }
        : { questionId: key.questionId, text: words };
    });
    await wf.answer(session.card.project, session.card.card, asked.id, { answers });
  }
  session.asked = undefined;
  session.answered = asked.id;
  // Workfloor queues the answer as the agent's next prompt, so its session reads idle for a moment:
  // the turn ends only once the agent has been seen at work again and stopped.
  if (session.turn) {
    session.turn.worked = false;
    session.turn.replied = false;
  }
  state.emit({
    type: "session.permission_resolved",
    sessionId: session.id,
    permissionId: asked.id,
  });
}

/**
 * Stop cancels the turn in Paseo at once, then stops Workfloor's agent as a best effort: a Workfloor
 * that fails or is slow never keeps the turn open, and a failure says the agent may still be working.
 */
async function interrupt(sessionId: string, state: State): Promise<void> {
  const session = state.sessions.get(sessionId)!;
  const turn = session.turn;
  if (!turn || turn.abort.signal.aborted) return;
  turn.abort.abort();
  session.turn = undefined;
  session.stopped = { question: session.asked?.id };
  forget(session, state);
  state.emit({ type: "session.turn", sessionId, turnId: turn.id, state: "canceled" });
  const card = session.card;
  if (!card) return;
  session.stopping = (async () => {
    try {
      const wf = await state.workfloor();
      // Stopped before the first read named the agent's session: read it, so Workfloor's agent stops too.
      session.workfloorSession ??= (await wf.detail(card)).sessionId;
      if (!session.workfloorSession)
        throw new WorkfloorError("Workfloor has not started its agent yet");
      await wf.stop({ ...card, session: session.workfloorSession });
    } catch (error) {
      console.error(`[workfloor-provider] stopping ${card.card}: ${message(error)}`);
      state.emit({
        type: "timeline.item",
        sessionId,
        item: {
          type: "notification",
          id: `${turn.id}-stop-failed`,
          level: "warning",
          message: `Workfloor's agent may still be working: stopping it failed (${message(error)}). Stop it in Workfloor.`,
        },
      });
    }
  })();
  await session.stopping;
  watch(session, state);
}

/** Drops the question raised in Paseo, resolving it there too, so Paseo keeps no stale copy. */
function forget(session: Session, state: State): void {
  if (!session.asked) return;
  state.emit({
    type: "session.permission_resolved",
    sessionId: session.id,
    permissionId: session.asked.id,
  });
  session.asked = undefined;
}

/**
 * The agent's own question, which a token may answer: not a plan step's go (Workfloor refuses a
 * token that), nor a handoff or issue it offers (its owner takes those on Workfloor's page).
 */
function answerable(waiting: WaitingQuestion | undefined): waiting is WaitingQuestion {
  return waiting?.kind === "agent" && !waiting.step && !waiting.handoff && !waiting.issue;
}

/** Workfloor no longer takes the token, or the conversation is gone: retrying cannot help. */
function gone(error: unknown): boolean {
  return error instanceof WorkfloorError && [401, 403, 404].includes(error.status ?? 0);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
