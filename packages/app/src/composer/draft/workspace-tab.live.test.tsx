/** @vitest-environment jsdom */
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Keyboard } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { beginStartup } from "@/workspace-startup/progress";
import { useWorkspaceStartupStore } from "@/workspace-startup/store";

const harness = vi.hoisted(() => ({
  isModelLoading: false,
  composerProps: null as Record<string, unknown> | null,
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));
vi.mock("@/composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    harness.composerProps = props;
    return null;
  },
}));
vi.mock("@/composer/dock", () => ({
  ComposerDock: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/file-drop/file-drop-zone", () => ({
  FileDropZone: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/agent-stream/view", () => ({ AgentStreamView: () => null }));
vi.mock("@/composer/draft/import-pill", () => ({ ComposerImportPill: () => null }));
vi.mock("@/composer/editing-session", () => ({
  useComposerEditingSession: () => null,
  useComposerFullscreen: () => false,
}));
vi.mock("@/workspace-startup/checklist", async () => {
  const { useDraftStartup } = await import("@/workspace-startup/store");
  return {
    DraftStartupChecklist: () => null,
    useStartupQueue: (input: { serverId: string; draftId: string; isSubmitting: boolean }) => {
      const progress = useDraftStartup(input);
      return { queueUntilReady: input.isSubmitting && progress !== null, placeholder: undefined };
    },
  };
});
vi.mock("@/hooks/use-agent-form-state", () => ({
  useAgentFormState: () => ({
    selectedServerId: "host-1",
    selectedProvider: "codex",
    selectedMode: "auto",
    selectedModel: "gpt-5.4",
    selectedThinkingOptionId: "",
    providerDefinitions: [{ id: "codex", label: "Codex" }],
    modeOptions: [],
    availableModels: [],
    availableThinkingOptions: [],
    modelSelectorProviders: [],
    isModelLoading: harness.isModelLoading,
    persistFormPreferences: async () => undefined,
  }),
}));
vi.mock("@/hooks/use-draft-agent-features", () => ({
  useDraftAgentFeatures: () => ({
    features: undefined,
    featureValues: undefined,
    setFeatureValue: () => undefined,
    applyProfileFeatureValues: () => undefined,
  }),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => "split" }));
vi.mock("@/hooks/use-container-width", () => ({
  useContainerWidthBelow: () => ({ onLayout: () => undefined, isBelow: false }),
}));
vi.mock("@/command-center/agent-control-registration", () => ({
  useAgentControlCommandCenterActions: () => undefined,
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceFields: () => ({ workspaceDirectory: "/repo/worktree", id: "wks_1" }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ drainQueuedAgentMessage: () => undefined }),
  useHostRuntimeClient: () => ({}),
  useHostRuntimeIsConnected: () => true,
}));

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

const { WorkspaceDraftAgentTab } = await import("./workspace-tab");

const DRAFT_ID = "draft-1";
const DRAFT_KEY = `draft:host-1:${DRAFT_ID}`;

function deferredCreation() {
  let resolve!: (snapshot: AgentSnapshotPayload) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<AgentSnapshotPayload>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { result, resolve, reject };
}

function pendSubmission(creation: ReturnType<typeof deferredCreation>) {
  const clientMessageId = `${DRAFT_ID}:initial-message`;
  useWorkspaceDraftSubmissionStore.getState().setPending({
    serverId: "host-1",
    workspaceId: "wks_1",
    draftId: DRAFT_ID,
    text: "First message",
    attachments: [],
    cwd: "/repo/worktree",
    provider: "codex",
    clientMessageId,
    timestamp: 1,
    allowEmptyText: true,
    agentCreation: { result: creation.result, retry: async () => creation.result },
  });
  useCreateFlowStore.getState().setPending({
    serverId: "host-1",
    draftId: DRAFT_ID,
    agentId: null,
    clientMessageId,
    text: "First message",
    timestamp: 1,
  });
}

function beginDraftStartup() {
  useWorkspaceStartupStore.getState().begin(
    beginStartup({
      serverId: "host-1",
      draftId: DRAFT_ID,
      agentLabel: "Codex",
      at: 1,
      isWorktree: true,
    }),
  );
}

const noop = () => undefined;
const afterPaint = () => new Promise((resolve) => setTimeout(resolve, 30));
const roots = new Set<Root>();

function mountTab(props: Partial<ComponentProps<typeof WorkspaceDraftAgentTab>> = {}) {
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing root container");
  const root = createRoot(container);
  roots.add(root);
  const render = () =>
    act(async () => {
      root.render(
        <WorkspaceDraftAgentTab
          serverId="host-1"
          workspaceId="wks_1"
          tabId="tab-1"
          draftId={DRAFT_ID}
          isPaneFocused
          onCreated={noop}
          onOpenWorkspaceFile={noop}
          {...props}
        />,
      );
    });
  return render;
}

const composer = () => {
  if (!harness.composerProps) throw new Error("Composer did not render");
  return harness.composerProps as unknown as {
    onChangeText: (text: string) => void;
    blurOnSubmit: boolean;
    queueUntilReady: boolean;
  };
};

const draftText = (draftKey: string) => useDraftStore.getState().getDraftInput(draftKey)?.text;

describe("WorkspaceDraftAgentTab while its agent starts", () => {
  beforeEach(() => {
    document.body.innerHTML = "<div id='root'></div>";
    harness.isModelLoading = false;
    harness.composerProps = null;
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
    useCreateFlowStore.setState({ pendingByDraftId: {} });
    useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, creationByDraftId: {} });
    useWorkspaceStartupStore.setState({ byDraftId: {} });
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots) root.unmount();
      roots.clear();
    });
    vi.restoreAllMocks();
  });

  it("keeps text typed before the pending submission is picked up, through to the agent", async () => {
    const creation = deferredCreation();
    pendSubmission(creation);
    beginDraftStartup();
    harness.isModelLoading = true;
    const onCreated = vi.fn();
    const render = mountTab({ onCreated });
    await render();

    expect(composer().queueUntilReady).toBe(true);
    await act(async () => {
      composer().onChangeText("Typed while models load");
    });
    await act(afterPaint);

    harness.isModelLoading = false;
    await render();
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId[DRAFT_ID]).toBeUndefined();
    expect(draftText(DRAFT_KEY)).toBe("Typed while models load");

    await act(async () => {
      creation.resolve({ id: "agent-1" } as AgentSnapshotPayload);
      await creation.result;
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(draftText("agent:host-1:agent-1")).toBe("Typed while models load");
    expect(draftText(DRAFT_KEY)).toBeUndefined();
  });

  it("puts the first message ahead of typed text when the start fails", async () => {
    const creation = deferredCreation();
    pendSubmission(creation);
    beginDraftStartup();
    const render = mountTab();
    await render();

    await act(async () => {
      composer().onChangeText("Typed since");
    });
    await act(async () => {
      creation.reject(new Error("Unable to create worktree"));
      await creation.result.catch(noop);
    });

    expect(draftText(DRAFT_KEY)).toBe("First message\n\nTyped since");
  });

  it("leaves the composer focused while the startup runs", async () => {
    const dismiss = vi.spyOn(Keyboard, "dismiss");
    pendSubmission(deferredCreation());
    beginDraftStartup();
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();

    await mountTab()();

    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId[DRAFT_ID]).toBeUndefined();
    expect(composer().blurOnSubmit).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("blurs and dismisses the keyboard when no startup is showing", async () => {
    const dismiss = vi.spyOn(Keyboard, "dismiss");
    pendSubmission(deferredCreation());
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();

    await mountTab()();

    expect(composer().blurOnSubmit).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(dismiss).toHaveBeenCalled();
  });
});
