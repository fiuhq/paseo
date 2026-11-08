import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  useAgent,
  useAgents,
  useProject,
  useProjects,
  useSettings,
  useWorkspace,
  useWorkspaces,
  type AgentRef,
  type PluginSidebarViewProps,
  type ProjectRef,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { layout } from "../shared/preferences";
import { agentCountLabel, agentTone, isExpanded, toggled, type Tone } from "../shared/tree";

type View_ = PluginSidebarViewProps;

interface Layout {
  readonly expanded: readonly string[];
  readonly toggle: (key: string) => void;
}

const INDENT = 14;

function toneColor(tone: Tone, view: View_): string {
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

function workspaceTone(indicator: string): Tone {
  if (indicator === "failed") return "failed";
  if (indicator === "needs_input" || indicator === "attention") return "attention";
  if (indicator === "running") return "running";
  return "idle";
}

function Dot({ color }: { color: string }) {
  const style = useMemo(
    () => ({ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 8 }),
    [color],
  );
  return <View style={style} />;
}

function AgentRow({ reference, depth, view }: { reference: AgentRef; depth: number; view: View_ }) {
  const agent = useAgent(reference);
  const open = useCallback(
    () => view.navigation.openAgent(reference),
    [view.navigation, reference],
  );
  const active = view.active.agent?.key === reference.key;
  const row = useMemo(
    () => ({
      ...rowStyle,
      paddingLeft: 12 + INDENT * depth,
      backgroundColor: active ? view.theme.colors.surface2 : undefined,
    }),
    [active, depth, view.theme],
  );
  const title = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12, flexShrink: 1 }),
    [view.theme],
  );
  const detail = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11, marginLeft: 6 }),
    [view.theme],
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
      <Dot color={toneColor(agentTone(agent), view)} />
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
  view: View_;
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

/** A root is an agent whose parent is not an agent of this workspace; its children draw under it. */
function RootAgent({
  reference,
  workspace,
  view,
}: {
  reference: AgentRef;
  workspace: WorkspaceRef;
  view: View_;
}) {
  const parent = useAgent(reference, (agent) => agent.parentAgent);
  const parentHere = useAgents({
    where: (item) =>
      parent != null && item.ref.key === parent.key && item.workspace.key === workspace.key,
  });
  if (parentHere.length > 0) return null;
  return <AgentTree reference={reference} workspace={workspace} depth={2} view={view} />;
}

function WorkspaceNode({
  reference,
  view,
  tree,
}: {
  reference: WorkspaceRef;
  view: View_;
  tree: Layout;
}) {
  const workspace = useWorkspace(reference);
  const agents = useAgents({
    where: (item) => item.workspace.key === reference.key,
    orderBy: "createdAt",
  });
  const expanded = isExpanded(tree.expanded, reference.key);
  const open = useCallback(
    () => view.navigation.openWorkspace(reference),
    [view.navigation, reference],
  );
  const toggle = useCallback(() => tree.toggle(reference.key), [tree, reference]);
  const active = view.active.workspace?.key === reference.key;
  const row = useMemo(
    () => ({
      ...rowStyle,
      paddingLeft: 4,
      backgroundColor: active ? view.theme.colors.surface2 : undefined,
    }),
    [active, view.theme],
  );
  const chevron = useMemo(
    () => ({
      color: view.theme.colors.foregroundMuted,
      fontSize: 10,
      width: 14,
      textAlign: "center" as const,
    }),
    [view.theme],
  );
  const title = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12, flexShrink: 1 }),
    [view.theme],
  );
  const detail = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11, marginLeft: 6 }),
    [view.theme],
  );
  if (!workspace) return null;
  const name = workspace.title ?? workspace.name;
  return (
    <View>
      <View style={row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Hide" : "Show"} agents in ${name}`}
          accessibilityState={{ expanded }}
          testID={`better-sidebar-toggle-${reference.key}`}
          onPress={toggle}
          disabled={agents.length === 0}
          hitSlop={6}
        >
          <Text style={chevron}>{agents.length === 0 ? " " : expanded ? "▾" : "▸"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${name}`}
          testID={`better-sidebar-workspace-${reference.key}`}
          onPress={open}
          style={rowBody}
        >
          <Dot color={toneColor(workspaceTone(workspace.indicator), view)} />
          <Text numberOfLines={1} style={title}>
            {name}
          </Text>
          <Text numberOfLines={1} style={detail}>
            {expanded ? (workspace.indicatorLabel ?? "") : agentCountLabel(agents.length)}
          </Text>
        </Pressable>
      </View>
      {expanded
        ? agents.map((agent) => (
            <RootAgent key={agent.key} reference={agent} workspace={reference} view={view} />
          ))
        : null}
    </View>
  );
}

function ProjectSection({
  reference,
  view,
  tree,
}: {
  reference: ProjectRef;
  view: View_;
  tree: Layout;
}) {
  const project = useProject(reference);
  const workspaces = useWorkspaces({
    where: (item) => item.project.key === reference.key && !item.background,
    orderBy: ["lastPromptAt", "desc"],
  });
  const newWorkspace = useCallback(
    () => view.navigation.openProject(reference),
    [view.navigation, reference],
  );
  const heading = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 }),
    [view.theme],
  );
  if (!project || workspaces.length === 0) return null;
  return (
    <View>
      <View style={headingRow}>
        <Text accessibilityRole="header" numberOfLines={1} style={heading}>
          {project.displayName}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New workspace in ${project.displayName}`}
          testID={`better-sidebar-new-${reference.key}`}
          onPress={newWorkspace}
          hitSlop={6}
        >
          <Text style={heading}>+</Text>
        </Pressable>
      </View>
      {workspaces.map((workspace) => (
        <WorkspaceNode key={workspace.key} reference={workspace} view={view} tree={tree} />
      ))}
    </View>
  );
}

export function BetterSidebar(view: View_) {
  const settings = useSettings(layout);
  const projects = useProjects({ orderBy: "displayName" });
  const ready = settings.status === "ready";
  const expanded = ready ? settings.values.expanded : [];
  const tree = useMemo<Layout>(
    () => ({
      expanded,
      toggle: (key) => {
        if (!ready) return;
        void settings.save({ expanded: toggled(expanded, key) }, settings.revision);
      },
    }),
    [expanded, ready, settings],
  );
  const notice = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 12, padding: 12 }),
    [view.theme],
  );
  if (settings.status === "loading") return <Text style={notice}>Loading…</Text>;
  if (settings.status !== "ready")
    return (
      <View>
        <Text style={notice}>{settings.error}</Text>
        <Pressable accessibilityRole="button" onPress={settings.reset}>
          <Text style={notice}>Reset the sidebar layout</Text>
        </Pressable>
      </View>
    );
  return (
    <ScrollView testID="better-sidebar">
      {projects.map((reference) => (
        <ProjectSection key={reference.key} reference={reference} view={view} tree={tree} />
      ))}
    </ScrollView>
  );
}

const rowStyle = {
  minHeight: 28,
  paddingRight: 12,
  paddingVertical: 4,
  flexDirection: "row",
  alignItems: "center",
} as const;

const rowBody = { flex: 1, flexDirection: "row", alignItems: "center" } as const;

const headingRow = {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingHorizontal: 12,
  paddingTop: 12,
  paddingBottom: 4,
} as const;
