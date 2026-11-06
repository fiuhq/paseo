import type pino from "pino";
import type { FirstAgentContext, WorkspaceTitleState } from "@getpaseo/protocol/messages";

import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import type { GitMutationService } from "./session/git-mutation/git-mutation-service.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedWorkspaceName,
  type GenerateBranchNameFromFirstAgentContextOptions,
} from "./worktree-branch-name-generator.js";
import { WorkspaceTitleGate, type ApplyJudgedTitleInput } from "./workspace-title-gate.js";

type WorkspaceNameGenerator = typeof generateBranchNameFromFirstAgentContext;

type CurrentSelection = GenerateBranchNameFromFirstAgentContextOptions["currentSelection"] | null;

interface WorkspaceAutoNameOptions {
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  workspaceGitService: WorkspaceGitService;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
  generateWorkspaceName?: WorkspaceNameGenerator;
  /** Lets a plugin hold titles until it passes one. Omitted, naming works as it always did. */
  titleGate?: {
    lifecycle: Pick<PluginLifecycle, "before">;
    workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  };
}

interface ScheduleContext {
  currentSelection?: CurrentSelection;
}

/** A title the gate already judged, so these paths must not generate another. */
interface JudgedTitle {
  generated: GeneratedWorkspaceName;
  titleState: WorkspaceTitleState | null;
}

export class WorkspaceAutoName {
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly readDaemonConfig: () => StructuredGenerationDaemonConfig;
  private readonly gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  private readonly emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly logger: pino.Logger;
  private readonly generateWorkspaceName: WorkspaceNameGenerator;
  private readonly titleGate: WorkspaceTitleGate | null;

  constructor(options: WorkspaceAutoNameOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.gitMutation = options.gitMutation;
    this.emitWorkspaceUpdateForCwd = options.emitWorkspaceUpdateForCwd;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.logger = options.logger;
    this.generateWorkspaceName =
      options.generateWorkspaceName ?? generateBranchNameFromFirstAgentContext;
    this.titleGate = options.titleGate
      ? new WorkspaceTitleGate({
          lifecycle: options.titleGate.lifecycle,
          agentManager: options.agentManager,
          workspaceRegistry: {
            get: (workspaceId) => options.titleGate!.workspaceRegistry.get(workspaceId),
            update: (workspaceId, updater) =>
              options.workspaceRegistry.update(workspaceId, updater),
          },
          generate: ({ workspace, firstAgentContext, selection }) =>
            this.generateFromContext({
              cwd: workspace.cwd,
              firstAgentContext,
              currentSelection: (selection as CurrentSelection | undefined) ?? null,
            }),
          apply: (input) => this.applyJudgedTitle(input),
          emit: (workspaceId) => options.emitWorkspaceUpdateForWorkspaceId(workspaceId),
          logger: options.logger,
        })
      : null;
  }

  private applyJudgedTitle(input: ApplyJudgedTitleInput): Promise<void> {
    const judged = { generated: input.generated, titleState: input.titleState };
    const firstAgentContext = input.firstAgentContext;
    if (input.workspace.kind === "worktree") {
      return this.maybeAutoNameWorkspaceBranchForFirstAgent({
        workspace: input.workspace,
        firstAgentContext,
        currentSelection: null,
        judged,
      });
    }
    return this.maybeAutoNameDirectoryWorkspaceTitle({
      workspaceId: input.workspace.workspaceId,
      cwd: input.workspace.cwd,
      firstAgentContext,
      currentSelection: null,
      judged,
    });
  }

  scheduleForWorktree(
    input: {
      workspace: PersistedWorkspaceRecord;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.schedule(
      () =>
        this.maybeAutoNameWorkspaceBranchForFirstAgent({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        cwd: input.workspace.cwd,
        message: "Failed to auto-name worktree branch",
      },
    );
  }

  scheduleForDirectory(
    input: {
      workspaceId: string;
      cwd: string;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.schedule(
      () =>
        this.maybeAutoNameDirectoryWorkspaceTitle({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      { cwd: input.cwd, message: "Failed to auto-name directory workspace title" },
    );
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
    judged?: JudgedTitle;
  }): Promise<void> {
    if (!input.judged && this.titleGate) {
      const workspace = await this.titleGate.heldWorkspace(input.workspace.workspaceId);
      if (workspace) {
        return this.titleGate.start(workspace, input.firstAgentContext, input.currentSelection);
      }
    }
    const worktreeRoot = input.workspace.worktreeRoot ?? input.workspace.cwd;
    let generated: GeneratedWorkspaceName | null = input.judged?.generated ?? null;
    const renameBranch = () =>
      attemptFirstAgentBranchAutoName({
        cwd: worktreeRoot,
        firstAgentContext: input.firstAgentContext,
        generateBranchNameFromContext: ({ firstAgentContext }) => {
          if (input.judged) return Promise.resolve(input.judged.generated.branch);
          return this.generateFromContext({
            cwd: input.workspace.cwd,
            firstAgentContext,
            currentSelection: input.currentSelection,
          }).then((nextGenerated) => {
            generated = nextGenerated;
            return nextGenerated?.branch ?? null;
          });
        },
      });
    const result: AttemptFirstAgentBranchAutoNameResult = input.judged
      ? await renameBranch().catch((error) => {
          this.logger.warn({ err: error, cwd: worktreeRoot }, "Failed to rename judged branch");
          return { attempted: true, renamed: false, branchName: null };
        })
      : await renameBranch();

    if (!generated) {
      generated = await this.generateFromContext({
        cwd: input.workspace.cwd,
        firstAgentContext: input.firstAgentContext,
        currentSelection: input.currentSelection,
      });
    }
    const generatedTitle = generated?.title ?? null;
    if (!generatedTitle) {
      return;
    }

    // K4: re-read from the registry before writing so any concurrent upsert
    // that happened between workspace creation and this async path is not clobbered.
    // When the first-agent rename changed the git branch too, persist that branch
    // alongside the title — both are this path's own fields.
    await this.applyGeneratedWorkspaceTitle(input.workspace.workspaceId, {
      title: generatedTitle,
      ...(result.renamed ? { branch: result.branchName } : {}),
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
      ...(input.judged ? { titleState: input.judged.titleState } : {}),
    });
    if (result.renamed) {
      await this.gitMutation.notifyGitMutation(worktreeRoot, "rename-branch");
    }
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
  }

  private async maybeAutoNameDirectoryWorkspaceTitle(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
    judged?: JudgedTitle;
  }): Promise<void> {
    if (!input.judged && this.titleGate) {
      const workspace = await this.titleGate.heldWorkspace(input.workspaceId);
      if (workspace) {
        return this.titleGate.start(workspace, input.firstAgentContext, input.currentSelection);
      }
    }
    const generated =
      input.judged?.generated ??
      (await this.generateFromContext({
        cwd: input.cwd,
        firstAgentContext: input.firstAgentContext,
        currentSelection: input.currentSelection,
      }));
    const title = generated?.title ?? null;
    if (!title) {
      return;
    }
    // K4: applyGeneratedWorkspaceTitle re-reads from the registry before writing.
    // Directory workspaces have no branch — write only the title.
    await this.applyGeneratedWorkspaceTitle(input.workspaceId, {
      title,
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
      ...(input.judged ? { titleState: input.judged.titleState } : {}),
    });
    await this.emitWorkspaceUpdateForWorkspaceId(input.workspaceId);
  }

  private async applyGeneratedWorkspaceTitle(
    workspaceId: string,
    input: {
      title: string;
      branch?: string | null;
      promptTitle?: string | null;
      titleState?: WorkspaceTitleState | null;
    },
  ): Promise<void> {
    await this.workspaceRegistry.update(workspaceId, (current) => {
      let title = current.title;
      if (!title || (input.promptTitle && title === input.promptTitle)) {
        title = input.title;
      }
      return {
        ...current,
        title,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.titleState !== undefined ? { titleState: input.titleState } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private generateFromContext(input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<GeneratedWorkspaceName | null> {
    return this.generateWorkspaceName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      workspaceGitService: this.workspaceGitService,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentSelection: input.currentSelection ?? undefined,
      firstAgentContext: input.firstAgentContext,
      logger: this.logger,
    });
  }

  private schedule(run: () => Promise<void>, context: { cwd: string; message: string }): void {
    setTimeout(() => {
      void run().catch((error) => {
        this.logger.warn({ err: error, cwd: context.cwd }, context.message);
      });
    }, 0);
  }
}
