import { Check, Circle } from "lucide-react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LiveElapsed } from "@/components/message";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import {
  describeStartup,
  formatSeconds,
  type ReadyView,
  type StartupProgress,
  type StepState,
} from "./progress";
import { useAgentStartup, useDraftStartup } from "./store";

const ThemedCheck = withUnistyles(Check);
const ThemedCircle = withUnistyles(Circle);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const doneIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type StepId = "workspace" | "agent" | "prompt";

interface StepRowProps {
  id: StepId;
  state: StepState;
  label: string;
  seconds: number | null;
  since: number | null;
  isFirst: boolean;
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <ThemedCheck size={14} uniProps={doneIconMapping} />;
  if (state === "running") return <ThemedSpinner size={14} uniProps={mutedIconMapping} />;
  return <ThemedCircle size={14} uniProps={mutedIconMapping} />;
}

function StepTime({ state, seconds, since }: Pick<StepRowProps, "state" | "seconds" | "since">) {
  const active = useRetainedPanelActive();
  if (state === "running" && since !== null) {
    return <LiveElapsed startedAt={new Date(since)} active={active} style={styles.time} />;
  }
  if (state === "done" && seconds !== null) {
    return <Text style={styles.time}>{formatSeconds(seconds)}</Text>;
  }
  return null;
}

function StepRow({ id, state, label, seconds, since, isFirst }: StepRowProps) {
  const isWaiting = state === "waiting";
  return (
    <View
      style={isFirst ? styles.row : [styles.row, settingsStyles.rowBorder]}
      testID={`workspace-startup-step-${id}`}
      // An agent reads each step's state here, in the DOM and the accessibility tree.
      aria-busy={state === "running"}
      aria-valuetext={state}
    >
      <View style={styles.icon}>
        <StepIcon state={state} />
      </View>
      <Text style={isWaiting ? styles.waitingLabel : styles.label}>{label}</Text>
      <StepTime state={state} seconds={seconds} since={since} />
    </View>
  );
}

/**
 * What a new workspace is doing until its agent can take the first message. Stands in for the
 * frozen composer between Enter and the agent's first turn; folds into a one-line summary once the
 * agent is ready.
 */
export function WorkspaceStartupChecklist({ progress }: { progress: StartupProgress }) {
  const { t } = useTranslation();
  const view = describeStartup(progress);
  if (view.kind === "ready")
    return <WorkspaceStartupSummary view={view} agentLabel={progress.agentLabel} />;

  const agent = progress.agentLabel;
  const { workspace } = view;
  const workspaceLabel = resolveWorkspaceLabel({
    t,
    isDone: workspace.state === "done",
    isWorktree: workspace.isWorktree,
    worktreeSlug: workspace.worktreeSlug,
  });
  return (
    <View style={styles.container} testID="workspace-startup-checklist">
      <Text style={styles.title}>{t("newWorkspace.startup.title")}</Text>
      <View style={settingsStyles.card}>
        <StepRow
          id="workspace"
          state={workspace.state}
          label={workspaceLabel}
          seconds={workspace.seconds}
          since={workspace.since}
          isFirst
        />
        <StepRow
          id="agent"
          state={view.agent.state}
          label={t("newWorkspace.startup.startingAgent", { agent })}
          seconds={view.agent.seconds}
          since={view.agent.since}
          isFirst={false}
        />
        <StepRow
          id="prompt"
          state="waiting"
          label={t("newWorkspace.startup.sendsWhenReady", { agent })}
          seconds={null}
          since={null}
          isFirst={false}
        />
      </View>
    </View>
  );
}

function resolveWorkspaceLabel(input: {
  t: ReturnType<typeof useTranslation>["t"];
  isDone: boolean;
  isWorktree: boolean;
  worktreeSlug: string | null;
}): string {
  const { t, isDone, isWorktree, worktreeSlug } = input;
  if (!isWorktree) {
    return isDone
      ? t("newWorkspace.startup.workspaceReady")
      : t("newWorkspace.startup.openingWorkspace");
  }
  if (!isDone) return t("newWorkspace.startup.creatingWorktree");
  return worktreeSlug
    ? t("newWorkspace.startup.worktreeReady", { name: worktreeSlug })
    : t("newWorkspace.startup.worktreeReadyUnnamed");
}

export function WorkspaceStartupSummary({
  view,
  agentLabel,
}: {
  view: ReadyView;
  agentLabel: string;
}) {
  const { t } = useTranslation();
  const values = {
    total: formatSeconds(view.totalSeconds),
    workspace: formatSeconds(view.workspaceSeconds),
    agent: agentLabel,
    agentTime: formatSeconds(view.agentSeconds),
  };
  const text = view.isWorktree
    ? t("newWorkspace.startup.summaryWorktree", values)
    : t("newWorkspace.startup.summaryWorkspace", values);
  return (
    <Text style={styles.summary} testID="workspace-startup-summary">
      {text}
    </Text>
  );
}

export interface StartupQueue {
  queueUntilReady: boolean;
  placeholder: string | undefined;
}

/** While a draft's agent starts, its composer queues behind the first message and says so. */
export function useStartupQueue(input: {
  serverId: string;
  draftId: string;
  isSubmitting: boolean;
}): StartupQueue {
  const { t } = useTranslation();
  const progress = useDraftStartup({ serverId: input.serverId, draftId: input.draftId });
  const queueUntilReady = input.isSubmitting && progress !== null;
  return useMemo(
    () => ({
      queueUntilReady,
      placeholder: queueUntilReady ? t("newWorkspace.startup.queuePlaceholder") : undefined,
    }),
    [queueUntilReady, t],
  );
}

/** The checklist for a draft whose workspace is starting; nothing once there is none. */
export function DraftStartupChecklist({
  serverId,
  draftId,
}: {
  serverId: string;
  draftId: string;
}) {
  const progress = useDraftStartup({ serverId, draftId });
  return progress ? <WorkspaceStartupChecklist progress={progress} /> : null;
}

/** How long the agent's workspace took to start, above its conversation, once it has. */
export function AgentStartupSummary({ serverId, agentId }: { serverId: string; agentId: string }) {
  const progress = useAgentStartup({ serverId, agentId });
  if (!progress) return null;
  const view = describeStartup(progress);
  return view.kind === "ready" ? (
    <WorkspaceStartupSummary view={view} agentLabel={progress.agentLabel} />
  ) : null;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginLeft: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  icon: {
    width: 16,
    alignItems: "center",
  },
  label: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  waitingLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  summary: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
}));
