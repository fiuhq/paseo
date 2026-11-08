import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useAgent,
  useAgents,
  type AgentRef,
  type PluginSidebarWorkspaceChildrenProps,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { agentTone, type Tone } from "../shared/tree";

type Props = PluginSidebarWorkspaceChildrenProps;

/** Lines an agent up under its workspace's title: chevron, status slot and their gaps. */
const INDENT = 52;
const STEP = 14;

function toneColor(tone: Tone, view: Props): string {
  const colors = view.theme.colors;
  switch (tone) {
    case "failed":
      return colors.statusDanger;
    case "attention":
      return colors.statusWarning;
    case "running":
      return colors.accent;
    case "closed":
      return colors.border;
    case "idle":
      return colors.foregroundMuted;
  }
}

function AgentRow({ reference, depth, view }: { reference: AgentRef; depth: number; view: Props }) {
  const agent = useAgent(reference);
  const open = useCallback(
    () => view.navigation.openAgent(reference),
    [view.navigation, reference],
  );
  const active = view.active.agent?.key === reference.key;
  const row = useMemo(
    () => ({
      flexDirection: "row" as const,
      alignItems: "center" as const,
      minHeight: 24,
      paddingLeft: INDENT + STEP * depth,
      paddingRight: 12,
      backgroundColor: active ? view.theme.colors.surface1 : undefined,
    }),
    [active, depth, view.theme],
  );
  const title = useMemo(
    () => ({
      color: view.theme.colors.foreground,
      opacity: active ? 1 : 0.76,
      fontSize: 13,
      flexShrink: 1,
    }),
    [active, view.theme],
  );
  const detail = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 12, marginLeft: 6 }),
    [view.theme],
  );
  const tone = agent ? agentTone(agent) : "idle";
  const dot = useMemo(
    () => ({
      width: 6,
      height: 6,
      borderRadius: 3,
      marginRight: 8,
      backgroundColor: toneColor(tone, view),
    }),
    [tone, view],
  );
  if (!agent) return null;
  const name = agent.title ?? agent.provider;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${name}`}
      testID={`better-sidebar-agent-${reference.key}`}
      onPress={open}
      style={row}
    >
      <View style={dot} />
      <Text numberOfLines={1} style={title}>
        {name}
      </Text>
      <Text numberOfLines={1} style={detail}>
        {agent.model ?? agent.provider}
      </Text>
    </Pressable>
  );
}

/** An agent and, beneath it, the agents it started in the same workspace. */
function AgentTree({
  reference,
  workspace,
  depth,
  view,
}: {
  reference: AgentRef;
  workspace: WorkspaceRef;
  depth: number;
  view: Props;
}) {
  const children = useAgents({
    where: (item) =>
      item.parentAgent?.key === reference.key && item.workspace.key === workspace.key,
    orderBy: "createdAt",
  });
  return (
    <View>
      <AgentRow reference={reference} depth={depth} view={view} />
      {children.map((child) => (
        <AgentTree
          key={child.key}
          reference={child}
          workspace={workspace}
          depth={depth + 1}
          view={view}
        />
      ))}
    </View>
  );
}

/** An agent whose parent is not in this workspace starts a tree; the rest draw under their parent. */
function RootAgent({ reference, view }: { reference: AgentRef; view: Props }) {
  const parent = useAgent(reference, (agent) => agent.parentAgent);
  const parentHere = useAgents({
    where: (item) =>
      parent != null && item.ref.key === parent.key && item.workspace.key === view.workspace.key,
  });
  if (parentHere.length > 0) return null;
  return <AgentTree reference={reference} workspace={view.workspace} depth={0} view={view} />;
}

/** The agents of one expanded workspace row in Paseo's sidebar. */
export function WorkspaceAgents(view: Props) {
  const agents = useAgents({
    where: (item) => item.workspace.key === view.workspace.key,
    orderBy: "createdAt",
  });
  const empty = useMemo(
    () => ({
      color: view.theme.colors.foregroundMuted,
      fontSize: 12,
      paddingLeft: INDENT,
      paddingVertical: 4,
    }),
    [view.theme],
  );
  if (agents.length === 0) return <Text style={empty}>No agents</Text>;
  return (
    <View testID={`better-sidebar-agents-${view.workspace.key}`}>
      {agents.map((agent) => (
        <RootAgent key={agent.key} reference={agent} view={view} />
      ))}
    </View>
  );
}
