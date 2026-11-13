import { randomUUID } from "node:crypto";
import { RequestBudget, retryAfterMs } from "./budget.js";

/**
 * Workfloor's conversation routes, as its own page calls them, with a personal token (`wfpat_…`) as the
 * person: Workfloor lets a token that writes reach `conversations`, `conversation`, `/api/events`,
 * `attachments`, the card's questions (`lane-flows/questions`) and Start agent (`lane-flows/agent-start`),
 * but never a step's go or an approval.
 * A conversation is a private card on its project's Conversations lane (`conversations:<project>`).
 */
export interface WorkfloorAuth {
  url: string;
  token: string;
}
export interface Project {
  id: string;
  name: string;
}
export interface Agent {
  id: string;
  name: string;
  model?: string;
}
/** A file a message carries, as Workfloor lists it and as a send takes it once uploaded. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind?: string;
  deliveryMode?: string;
}
export interface Message {
  id: string;
  role: "agent" | "user";
  body: string;
  tool?: { name: string; status: string; input: string };
  attachments?: Attachment[];
}
export interface Detail {
  title?: string;
  sessionId?: string;
  sessions?: Array<{
    id: string;
    state: string;
    agentProfileId?: string;
    agentName?: string;
    error?: string;
  }>;
  messages: Message[];
  pendingAction?: "question" | "permission";
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt?: string;
}
/** What waits on the person: the agent's `card_ask` (`agent`), or the lane's own ask or approval. */
export interface WaitingQuestion {
  id: string;
  kind: "ask" | "approval" | "agent";
  question: string;
  options?: string[];
  questions?: Array<{
    id?: string;
    title?: string;
    prompt: string;
    options?: Array<{ label: string; description?: string }>;
  }>;
  context?: string;
  /** A plan step waiting for its go: Workfloor refuses a token's answer to it. */
  step?: unknown;
  /** A handoff or an issue the agent offers to make: its owner takes it on Workfloor's page. */
  handoff?: unknown;
  issue?: unknown;
}
/** A card's stage whose agent never started there. */
export interface IdleStage {
  stageId: string;
  stage: string;
  entry: number;
  yours?: boolean;
}
/** One answer per question, an option by its number ("1", "2", …) or the person's words; or a decline. */
export type QuestionReply =
  | { answers: Array<{ questionId: string; optionId?: string; text?: string }> }
  | { reject: string };
/**
 * A card as its own view reads it: its title, its repository and the issues and pull requests
 * linked to it. A few kilobytes, where the card's full read carries every message it ever had.
 */
export interface CardView {
  title?: string;
  /** The stage the card is on. */
  stageId?: string;
  /** The name of the agent that has the card now. */
  agent?: string;
  /** Its agent's state on the board: `idle`, `waiting`, `ready` or `done` once it stopped. */
  agentState?: string;
  /** What the card asks its people, when it asks. */
  question?: unknown;
  /** Its stage's approval gates: the ways out a person must approve, and the stages past one. */
  gates?: {
    ways: Array<{ to: string; label: string }>;
    locked: Array<{ stage: string; gate: string; through: string }>;
    approves?: Array<{ to: string; gate: string }>;
  };
  repository?: string;
  externalItems?: Array<{
    kind: string;
    repository?: string;
    number?: number;
    state?: string | null;
  }>;
}
/** A lane's stage, in the lane's order, and the agent profile it runs, if it runs one. */
export interface LaneStage {
  id: string;
  name: string;
  agentProfileId?: string;
}
/** A card by the IDs Workfloor's routes take: a conversation is a card on its project's Conversations lane. */
export interface CardRef {
  project: string;
  card: string;
  lane: string;
}
/** A card's agent session. */
export interface Scope extends CardRef {
  session: string;
}

const STOPPED = new Set(["idle", "waiting", "ready", "done"]);

/**
 * The gate a lane card waits on a person to pass, by its name ("Approve plan to build"), once its
 * agent stopped and asks nothing: the card moves on only when someone takes that decision in Workfloor.
 */
export function gateWaiting(view: CardView): string | undefined {
  if (view.question || !view.agentState || !STOPPED.has(view.agentState)) return undefined;
  const gates = view.gates;
  return gates?.approves?.[0]?.gate ?? gates?.ways[0]?.label ?? gates?.locked[0]?.gate;
}

export class WorkfloorError extends Error {
  constructor(
    message: string,
    /** The HTTP status Workfloor answered with, when it answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export const lane = (project: string) => `conversations:${project}`;

/** The card a Workfloor page link opens (`?project=…&workflow=…&task=…`), from any text holding one. */
export function cardOfLink(text: string | undefined): CardRef | undefined {
  const found = text?.match(/https?:\/\/\S+/)?.[0];
  if (!found) return undefined;
  try {
    const query = new URL(found).searchParams;
    const project = query.get("project");
    const card = query.get("task");
    const workflow = query.get("workflow");
    if (!project || !card || !workflow) return undefined;
    return { project, card, lane: workflow };
  } catch {
    return undefined;
  }
}

/** The card a Workfloor short link names (`/c/<card id>`, its Copy link), from any text holding one. */
export function cardIdOfShortLink(text: string | undefined): string | undefined {
  const found = text?.match(/https?:\/\/\S+/)?.[0];
  if (!found) return undefined;
  try {
    return new URL(found).pathname.match(/^\/c\/([^/]+)\/?$/)?.[1];
  } catch {
    return undefined;
  }
}

/** A request Workfloor refused for the token's rate is sent this many times before its 429 is returned. */
const REFUSED_ATTEMPTS = 4;

export class Workfloor {
  constructor(
    private readonly auth: WorkfloorAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    /** The token's requests, shared by every client of this token. */
    private readonly budget: RequestBudget,
  ) {}

  /** Every call takes a slot of the token's budget; one Workfloor refused is asked again once it allows. */
  private async call(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      await this.budget.take();
      const response = await this.fetchImpl(url, init);
      if (response.status !== 429 || attempt >= REFUSED_ATTEMPTS) return response;
      this.budget.refused(retryAfterMs(response.headers.get("retry-after")));
      await response.body?.cancel().catch(() => undefined);
    }
  }

  /** The card's page in Workfloor, for a person to open. */
  link(ref: CardRef): string {
    const query = new URLSearchParams({
      project: ref.project,
      workflow: ref.lane,
      page: ref.lane === lane(ref.project) ? "conversations" : "lanes",
      task: ref.card,
    });
    return `${this.auth.url}/?${query}`;
  }

  async projects(): Promise<Project[]> {
    return (await this.request<{ projects: Project[] }>("connection?view=bootstrap")).projects;
  }

  agents(project: string): Promise<Agent[]> {
    return this.request(
      `connection?${new URLSearchParams({ view: "agents", workspace: project, workflow: lane(project) })}`,
    );
  }

  /** Every agent the project offers its lanes, by profile id and name. */
  projectAgents(project: string): Promise<Agent[]> {
    return this.request(
      `connection?${new URLSearchParams({ view: "agents", workspace: project })}`,
    );
  }

  async laneStages(project: string, lane: string): Promise<LaneStage[]> {
    const query = new URLSearchParams({ view: "lane-stages", workspace: project, workflow: lane });
    return (await this.request<{ stages?: LaneStage[] }>(`connection?${query}`)).stages ?? [];
  }

  /** The project's lanes, by id; its Conversations lane is not among them. */
  async lanes(project: string): Promise<string[]> {
    const query = new URLSearchParams({ view: "workflows", workspace: project });
    const read = await this.request<{ workflows?: Array<{ id: string }> }>(`connection?${query}`);
    return (read.workflows ?? []).map((w) => w.id);
  }

  async conversations(project: string): Promise<Conversation[]> {
    const query = new URLSearchParams({ workspace: project });
    return (await this.request<{ conversations: Conversation[] }>(`conversations?${query}`))
      .conversations;
  }

  /** Starts a conversation with the agent and its first message; the agent starts at once. */
  async start(project: string, agent: string, message: string): Promise<string> {
    const body = { operationId: randomUUID(), workspace: project, agentProfileId: agent, message };
    const started = await this.request<{ conversation?: { id: string } }>("conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!started.conversation?.id) throw new WorkfloorError("Workfloor started no conversation");
    return started.conversation.id;
  }

  /** `archived`: an archived card, read only, as its Workfloor page opens it; Workfloor refuses it otherwise. */
  detail(ref: CardRef, options: { archived?: boolean } = {}): Promise<Detail> {
    const query = new URLSearchParams({
      view: "detail",
      workspace: ref.project,
      workflow: ref.lane,
      task: ref.card,
      ...(options.archived ? { archived: "read" } : {}),
    });
    return this.request(`connection?${query}`);
  }

  /**
   * The card's stage whose agent never started there (a card made or moved without its agent),
   * as Workfloor's Start agent reads it; `yours` when the person may start it.
   */
  async idleStage(ref: CardRef): Promise<IdleStage | undefined> {
    const query = new URLSearchParams({ workspace: ref.project, card: ref.card });
    return (await this.request<{ idle?: IdleStage }>(`lane-flows/agent-failure?${query}`)).idle;
  }

  /** Starts that stage's agent as the person, with their words in its handoff (Start agent). */
  startStageAgent(ref: CardRef, idle: IdleStage, words: string): Promise<unknown> {
    return this.request("lane-flows/agent-start", {
      method: "POST",
      body: JSON.stringify({
        workspace: ref.project,
        card: ref.card,
        stage: idle.stageId,
        entry: idle.entry,
        ...(words ? { context: words } : {}),
      }),
    });
  }

  /** The card as its card view reads it; refused, as its full read is, on any lane but its own. */
  async card(ref: CardRef): Promise<CardView> {
    const query = new URLSearchParams({
      view: "card",
      workspace: ref.project,
      workflow: ref.lane,
      task: ref.card,
    });
    return (await this.request<{ task?: CardView }>(`connection?${query}`)).task ?? {};
  }

  /** What waits on the person on this card, as Workfloor's card panel reads it. */
  async question(project: string, card: string): Promise<WaitingQuestion | undefined> {
    const query = new URLSearchParams({ workspace: project, card });
    return (await this.request<{ question?: WaitingQuestion }>(`lane-flows/questions?${query}`))
      .question;
  }

  /** Answers the question the card waits on, as its question form does. */
  answer(project: string, card: string, question: string, reply: QuestionReply): Promise<unknown> {
    return this.request("lane-flows/questions", {
      method: "POST",
      body: JSON.stringify({ workspace: project, card, question, ...reply }),
    });
  }

  send(scope: Scope, body: string, attachments: Attachment[] = []): Promise<unknown> {
    return this.command(scope, { kind: "send", body, attachments, clientId: randomUUID() });
  }

  /** Uploads a file for the next message to the card's current session, as its composer does. */
  upload(
    scope: Scope,
    file: { name: string; mimeType: string; bytes: Uint8Array },
  ): Promise<Attachment> {
    const form = new FormData();
    form.append("workspace", scope.project);
    form.append("workflow", scope.lane);
    form.append("task", scope.card);
    form.append("session", scope.session);
    form.append("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }));
    return this.request("attachments", { method: "POST", body: form });
  }

  /** A picture a message on the card carries, as its thumbnail reads it. */
  async picture(
    scope: Scope & { message: string },
    id: string,
  ): Promise<{ bytes: Uint8Array; type: string }> {
    const query = new URLSearchParams({
      workspace: scope.project,
      workflow: scope.lane,
      task: scope.card,
      session: scope.session,
      message: scope.message,
      id,
    });
    const response = await this.call(`${this.auth.url}/api/attachments/content?${query}`, {
      headers: { authorization: `Bearer ${this.auth.token}` },
    });
    if (!response.ok)
      throw new WorkfloorError(
        `Workfloor answered ${response.status} to a picture`,
        response.status,
      );
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      type: response.headers.get("content-type") ?? "image/png",
    };
  }

  stop(scope: Scope): Promise<unknown> {
    return this.command(scope, { kind: "stop" });
  }

  /**
   * Holds Workfloor's live stream of the conversation open, calling `onEvent` on each event it sends
   * (its page re-reads the card on these), until `signal` aborts or the stream ends.
   */
  async events(
    scope: CardRef & { session?: string },
    signal: AbortSignal,
    onEvent: () => void,
  ): Promise<void> {
    const query = new URLSearchParams({
      workspace: scope.project,
      workflow: scope.lane,
      task: scope.card,
      ...(scope.session ? { session: scope.session } : {}),
    });
    const response = await this.call(`${this.auth.url}/api/events?${query}`, {
      headers: { authorization: `Bearer ${this.auth.token}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body)
      throw new WorkfloorError(
        `Workfloor's live stream answered ${response.status}`,
        response.status,
      );
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^data:/m.test(frame)) onEvent();
      }
    }
  }

  private command(scope: Scope, command: Record<string, unknown>): Promise<unknown> {
    const body = {
      workspace: scope.project,
      workflow: scope.lane,
      task: scope.card,
      session: scope.session,
      command,
    };
    return this.request("conversation", { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.call(`${this.auth.url}/api/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.auth.token}`,
        // A form sets its own multipart type.
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
      },
    });
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    if (!response.ok) {
      const route = path.split("?")[0];
      throw new WorkfloorError(
        typeof body?.error === "string"
          ? body.error
          : `Workfloor answered ${response.status} to ${route}`,
        response.status,
      );
    }
    return body as T;
  }
}
