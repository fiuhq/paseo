import { useEffect, useMemo, useState } from "react";
import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import { buildCity, type Street, type Tone } from "../shared/city";

export type Theme = PluginScreenProps["theme"];

type Paseo = ReturnType<typeof usePaseo>;
type WorkspacePage = Awaited<ReturnType<Paseo["workspaces"]["list"]>>;
type AgentPage = Awaited<ReturnType<Paseo["agents"]["list"]>>;
type Workspace = WorkspacePage["entries"][number];
type Agent = AgentPage["entries"][number]["agent"];

export function toneColor(tone: Tone, theme: Theme): string {
  switch (tone) {
    case "failed":
      return theme.colors.statusDanger;
    case "attention":
      return theme.colors.statusWarning;
    case "running":
      return theme.colors.accent;
    case "closed":
      return theme.colors.border;
    case "idle":
      return theme.colors.foregroundMuted;
  }
}

const PAGE = 200;

export interface City {
  readonly streets: readonly Street[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * The selected host's workspaces and agents, kept live. Screens get the plugin's Paseo client but
 * not the app's state hooks, so this lists both directories once, then applies their updates.
 */
export function useCity(): City {
  const paseo = usePaseo();
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [directory] = useState(() => ({
    workspaces: new Map<string, Workspace>(),
    agents: new Map<string, Agent>(),
  }));

  useEffect(() => {
    let live = true;
    const { workspaces, agents } = directory;
    workspaces.clear();
    agents.clear();
    const changed = () => {
      if (live) setVersion((value) => value + 1);
    };
    const subscriptions: { release(): Promise<void> }[] = [];
    const release = () => {
      for (const subscription of subscriptions.splice(0))
        void subscription.release().catch(() => {});
    };
    const stopWorkspaces = paseo.workspaces.subscribe((update) => {
      if (update.kind === "upsert") workspaces.set(update.workspace.id, update.workspace);
      else workspaces.delete(update.id);
      changed();
    });
    const stopAgents = paseo.agents.subscribe((update) => {
      if (update.kind === "upsert") agents.set(update.agent.id, update.agent);
      else agents.delete(update.agentId);
      changed();
    });

    // An update can land before the first page does; the page never overwrites it.
    // ponytail: an entry removed before its page lands comes back until its next update.
    async function load() {
      const sort = [{ key: "activity_at" as const, direction: "desc" as const }];
      const workspaceFeed = await paseo.workspaces.list({
        sort,
        page: { limit: PAGE },
        subscribe: {},
      });
      subscriptions.push(workspaceFeed.subscription);
      let workspacePage: WorkspacePage = workspaceFeed;
      while (live) {
        for (const workspace of workspacePage.entries)
          if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, workspace);
        const cursor = workspacePage.pageInfo.nextCursor;
        if (!workspacePage.pageInfo.hasMore || !cursor) break;
        workspacePage = await paseo.workspaces.list({ sort, page: { limit: PAGE, cursor } });
      }
      const agentFeed = await paseo.agents.list({
        scope: "active",
        page: { limit: PAGE },
        subscribe: {},
      });
      subscriptions.push(agentFeed.subscription);
      let agentPage: AgentPage = agentFeed;
      while (live) {
        for (const { agent } of agentPage.entries)
          if (!agents.has(agent.id)) agents.set(agent.id, agent);
        const cursor = agentPage.pageInfo.nextCursor;
        if (!agentPage.pageInfo.hasMore || !cursor) break;
        agentPage = await paseo.agents.list({ scope: "active", page: { limit: PAGE, cursor } });
      }
    }
    setLoading(true);
    setError(null);
    load()
      .then(() => {
        if (!live) return release();
        setLoading(false);
        changed();
      })
      .catch((reason: unknown) => {
        if (!live) return release();
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
      stopWorkspaces();
      stopAgents();
      release();
    };
  }, [paseo, directory]);

  const streets = useMemo(
    () => buildCity(directory.workspaces.values(), directory.agents.values()),
    // The maps mutate in place; `version` is what changes when they do.
    [directory, version],
  );
  return { streets, loading, error };
}
