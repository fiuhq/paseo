import type pino from "pino";
import type { PluginWorkspaceTitleRequest } from "@getpaseo/plugin/server";
import {
  isWorkspaceTitleHeld,
  type FirstAgentContext,
  type WorkspaceTitleState,
} from "@getpaseo/protocol/messages";

import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import type { GeneratedWorkspaceName } from "./worktree-branch-name-generator.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

const TITLE_HOOK = "workspace.title.before";
const MAX_TRIES = 3;
const SOURCE_TEXT_CHARS = 2000;
const REPLY_CONTEXT_CHARS = 4000;

export const HELD_TITLE_STATE: WorkspaceTitleState = {
  status: "naming",
  attempts: 0,
  refusedTitle: null,
  score: null,
  judge: null,
};

type Verdict = NonNullable<PluginWorkspaceTitleRequest["verdict"]>;
type CandidateOrigin = Pick<PluginWorkspaceTitleRequest, "source" | "sourceText">;

export interface ApplyJudgedTitleInput {
  workspace: PersistedWorkspaceRecord;
  firstAgentContext: FirstAgentContext;
  generated: GeneratedWorkspaceName;
  /** Null once the title passed; a state only when it went on unchecked. */
  titleState: WorkspaceTitleState | null;
}

interface WorkspaceTitleGateDeps {
  lifecycle: Pick<PluginLifecycle, "before">;
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  generate(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    selection: unknown;
  }): Promise<GeneratedWorkspaceName | null>;
  apply(input: ApplyJudgedTitleInput): Promise<void>;
  emit(workspaceId: string): Promise<void>;
  logger: pino.Logger;
}

/**
 * Holds a new workspace's title until a plugin's judge passes one.
 *
 * Paseo's own auto-naming makes one call at creation, from the prompt alone, and shows
 * whatever comes back. That reads a link as nothing and guesses. With a judge registered
 * on `workspace.title.before`, a refused candidate is dropped and the next one is written
 * from the agent's reply, when the agent has actually read the link. The branch rename
 * waits for the same pass. With no judge registered, nothing here runs.
 */
export class WorkspaceTitleGate {
  private readonly starts = new Map<string, { context: FirstAgentContext; selection: unknown }>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorkspaceTitleGateDeps) {
    deps.agentManager.subscribe((event) => this.onAgentEvent(event), { replayState: false });
  }

  async heldWorkspace(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    const workspace = await this.deps.workspaceRegistry.get(workspaceId);
    return workspace && isWorkspaceTitleHeld(workspace.titleState) ? workspace : null;
  }

  start(
    workspace: PersistedWorkspaceRecord,
    firstAgentContext: FirstAgentContext,
    selection?: unknown,
  ): Promise<void> {
    this.starts.set(workspace.workspaceId, { context: firstAgentContext, selection });
    return this.enqueue(workspace.workspaceId, () =>
      this.attempt(workspace.workspaceId, firstAgentContext, {
        source: "prompt",
        sourceText: firstAgentContext.prompt ?? "",
      }),
    );
  }

  /** Resolves once everything queued for the workspace has run. */
  settled(workspaceId: string): Promise<void> {
    return this.queues.get(workspaceId) ?? Promise.resolve();
  }

  private onAgentEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream") return;
    const turn = event.event.type;
    if (turn !== "turn_completed" && turn !== "turn_failed" && turn !== "turn_canceled") return;
    const workspaceId = this.deps.agentManager.getAgent(event.agentId)?.workspaceId;
    if (!workspaceId) return;
    void this.enqueue(workspaceId, () => this.afterTurn(workspaceId, event.agentId));
  }

  private async afterTurn(workspaceId: string, agentId: string): Promise<void> {
    const state = (await this.deps.workspaceRegistry.get(workspaceId))?.titleState;
    if (!isWorkspaceTitleHeld(state) || !state || state.status === "exhausted") return;
    const reply = await this.deps.agentManager.getLastAssistantMessage(agentId);
    if (!reply?.trim()) {
      await this.setState(workspaceId, { ...state, status: "no-reply" });
      return;
    }
    const context = this.starts.get(workspaceId)?.context;
    const replyText = reply.trim().slice(0, REPLY_CONTEXT_CHARS);
    const sourceText = [replyText, context?.prompt].filter(Boolean).join("\n\n");
    let prompt = [context?.prompt, `The agent has replied:\n${replyText}`]
      .filter(Boolean)
      .join("\n\n");
    // The agent may never take another turn, so a refusal cannot wait for one.
    for (;;) {
      await this.attempt(workspaceId, { ...context, prompt }, { source: "reply", sourceText });
      const next = (await this.deps.workspaceRegistry.get(workspaceId))?.titleState;
      if (next?.status !== "refused") return;
      prompt = `${prompt}\n\nA reviewer refused the title "${next.refusedTitle}" as not specific enough. Name the concrete thing being fixed, built or answered.`;
    }
  }

  private async attempt(
    workspaceId: string,
    firstAgentContext: FirstAgentContext,
    origin: CandidateOrigin,
  ): Promise<void> {
    const workspace = await this.deps.workspaceRegistry.get(workspaceId);
    const state = workspace?.titleState;
    if (!workspace || !state || !isWorkspaceTitleHeld(state)) return;
    const attempt = state.attempts + 1;

    const generated = await this.deps.generate({
      workspace,
      firstAgentContext,
      selection: this.starts.get(workspaceId)?.selection,
    });
    if (!generated?.title) {
      await this.refused(workspaceId, attempt, { ...state, attempts: attempt });
      return;
    }

    const verdict = await this.judge({
      workspaceId,
      candidate: { title: generated.title, branch: generated.branch },
      source: origin.source,
      sourceText: origin.sourceText.slice(0, SOURCE_TEXT_CHARS),
      attempt,
      verdict: null,
    });

    if (verdict.decision === "refuse") {
      await this.refused(workspaceId, attempt, {
        status: "refused",
        attempts: attempt,
        refusedTitle: generated.title,
        score: verdict.score,
        judge: verdict.judge,
      });
      return;
    }

    // Re-read: a rename that landed while the judge scored must win.
    const current = await this.deps.workspaceRegistry.get(workspaceId);
    if (!current || !isWorkspaceTitleHeld(current.titleState)) return;
    await this.deps.apply({
      workspace: current,
      firstAgentContext,
      generated,
      titleState:
        verdict.decision === "unchecked"
          ? { ...HELD_TITLE_STATE, status: "unchecked", attempts: attempt, judge: verdict.judge }
          : null,
    });
    this.starts.delete(workspaceId);
  }

  private async judge(request: PluginWorkspaceTitleRequest): Promise<Verdict> {
    try {
      const { verdict } = await this.deps.lifecycle.before(TITLE_HOOK, request);
      return verdict ?? { decision: "unchecked", score: null, judge: null };
    } catch (error) {
      this.deps.logger.warn(
        { err: error, workspaceId: request.workspaceId },
        "Workspace title judge failed; applying the title unchecked",
      );
      return { decision: "unchecked", score: null, judge: null };
    }
  }

  private refused(workspaceId: string, attempt: number, next: WorkspaceTitleState): Promise<void> {
    return this.setState(
      workspaceId,
      attempt >= MAX_TRIES ? { ...next, status: "exhausted" } : next,
    );
  }

  private async setState(workspaceId: string, titleState: WorkspaceTitleState): Promise<void> {
    await this.deps.workspaceRegistry.update(workspaceId, (current) =>
      isWorkspaceTitleHeld(current.titleState)
        ? { ...current, titleState, updatedAt: new Date().toISOString() }
        : current,
    );
    await this.deps.emit(workspaceId);
  }

  /** One decision at a time per workspace: a fast first turn must see the first try's result. */
  private enqueue(workspaceId: string, work: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(workspaceId) ?? Promise.resolve()).then(work).catch((error) => {
      this.deps.logger.warn({ err: error, workspaceId }, "Workspace title gate failed");
    });
    this.queues.set(workspaceId, run);
    return run;
  }
}
