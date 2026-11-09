import { randomUUID } from "node:crypto";

/**
 * Workfloor's conversation routes, as its own page calls them, with a personal token (`wfpat_…`) as the
 * person: Workfloor lets a token that writes reach `conversations`, `conversation`, `/api/events` and
 * the card's questions (`lane-flows/questions`), but never a step's go or an approval.
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
export interface Message {
  id: string;
  role: "agent" | "user";
  body: string;
  tool?: { name: string; status: string; input: string };
}
export interface Detail {
  title?: string;
  sessionId?: string;
  sessions?: Array<{ id: string; state: string; agentProfileId?: string; error?: string }>;
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
/** One answer per question, an option by its number ("1", "2", …) or the person's words; or a decline. */
export type QuestionReply =
  | { answers: Array<{ questionId: string; optionId?: string; text?: string }> }
  | { reject: string };
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

/**
 * The card a Workfloor page link opens (`?project=…&workflow=…&task=…`), from any text holding one;
 * a link without its lane is a conversation's.
 */
export function cardOfLink(text: string | undefined): CardRef | undefined {
  const found = text?.match(/https?:\/\/\S+/)?.[0];
  if (!found) return undefined;
  try {
    const query = new URL(found).searchParams;
    const project = query.get("project");
    const card = query.get("task");
    if (!project || !card) return undefined;
    return { project, card, lane: query.get("workflow") || lane(project) };
  } catch {
    return undefined;
  }
}

export class Workfloor {
  constructor(
    private readonly auth: WorkfloorAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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

  detail(ref: CardRef): Promise<Detail> {
    const query = new URLSearchParams({
      view: "detail",
      workspace: ref.project,
      workflow: ref.lane,
      task: ref.card,
    });
    return this.request(`connection?${query}`);
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

  send(scope: Scope, body: string): Promise<unknown> {
    return this.command(scope, { kind: "send", body, attachments: [], clientId: randomUUID() });
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
    const response = await this.fetchImpl(`${this.auth.url}/api/events?${query}`, {
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
    const response = await this.fetchImpl(`${this.auth.url}/api/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.auth.token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
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
