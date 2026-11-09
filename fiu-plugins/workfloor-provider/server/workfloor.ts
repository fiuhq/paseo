import { randomUUID } from "node:crypto";

/**
 * Workfloor's conversation routes, as its own page calls them, with a personal token (`wfpat_…`) as the
 * person: Workfloor lets a token that writes reach `conversations`, `conversation` and `/api/events`.
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
/** A conversation's agent session, by the IDs Workfloor's routes take. */
export interface Scope {
  project: string;
  card: string;
  session: string;
}

export class WorkfloorError extends Error {}

export const lane = (project: string) => `conversations:${project}`;

export class Workfloor {
  constructor(
    private readonly auth: WorkfloorAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The conversation's page in Workfloor, for a person to open. */
  link(project: string, card: string): string {
    const query = new URLSearchParams({
      project,
      workflow: lane(project),
      page: "conversations",
      task: card,
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

  detail(project: string, card: string): Promise<Detail> {
    const query = new URLSearchParams({
      view: "detail",
      workspace: project,
      workflow: lane(project),
      task: card,
    });
    return this.request(`connection?${query}`);
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
    scope: Pick<Scope, "project" | "card"> & { session?: string },
    signal: AbortSignal,
    onEvent: () => void,
  ): Promise<void> {
    const query = new URLSearchParams({
      workspace: scope.project,
      workflow: lane(scope.project),
      task: scope.card,
      ...(scope.session ? { session: scope.session } : {}),
    });
    const response = await this.fetchImpl(`${this.auth.url}/api/events?${query}`, {
      headers: { authorization: `Bearer ${this.auth.token}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body)
      throw new WorkfloorError(`Workfloor's live stream answered ${response.status}`);
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
      workflow: lane(scope.project),
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
      );
    }
    return body as T;
  }
}
