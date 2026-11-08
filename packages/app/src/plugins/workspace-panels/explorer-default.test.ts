import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import type { PluginPanelLocation } from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import { findExplorerDefaultPanel, withTabFirst } from "./explorer-default";

type Panel = InstalledPlugin["workspacePanels"][number];

interface PanelInput {
  id?: string;
  locations: readonly PluginPanelLocation[];
  explorerDefault?: boolean;
}

function plugin(id: string, serverId: string, panels: PanelInput[]): InstalledPlugin {
  return {
    id,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    settingsScreens: [],
    surfaces: [],
    sidebarViews: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: panels.map(
      (panel): Panel => ({
        id: panel.id ?? "p",
        title: "P",
        icon: "Box",
        context: "workspace",
        locations: panel.locations,
        Component: () => null,
        ...(panel.explorerDefault === undefined ? {} : { explorerDefault: panel.explorerDefault }),
      }),
    ),
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("findExplorerDefaultPanel", () => {
  it("picks the first panel on the host that asks to be the Explorer's default", () => {
    const plugins = [
      plugin("other-host", "srv-2", [{ id: "x", explorerDefault: true, locations: ["explorer"] }]),
      plugin("plain", "srv-1", [{ id: "files-like", locations: ["explorer"] }]),
      plugin("fiu-cli", "srv-1", [
        { id: "mockups", explorerDefault: true, locations: ["explorer", "workspace"] },
      ]),
      plugin("later", "srv-1", [{ id: "late", explorerDefault: true, locations: ["explorer"] }]),
    ];
    expect(findExplorerDefaultPanel(plugins, "srv-1:ws-main")).toEqual({
      kind: "plugin",
      pluginId: "fiu-cli",
      panelId: "mockups",
      context: "workspace",
    });
  });

  it("finds none when no panel on the host asks", () => {
    expect(
      findExplorerDefaultPanel(
        [plugin("plain", "srv-1", [{ locations: ["explorer"] }])],
        "srv-1:ws-main",
      ),
    ).toBeNull();
    expect(findExplorerDefaultPanel([], "srv-1:ws-main")).toBeNull();
  });

  it("finds the workspace's host when a server id holds ':'", () => {
    const plugins = [
      plugin("short", "host", [{ id: "wrong", explorerDefault: true, locations: ["explorer"] }]),
      plugin("fiu-cli", "host:6767", [
        { id: "storyboard", explorerDefault: true, locations: ["explorer"] },
      ]),
    ];
    expect(findExplorerDefaultPanel(plugins, "host:6767:ws-main")).toEqual({
      kind: "plugin",
      pluginId: "fiu-cli",
      panelId: "storyboard",
      context: "workspace",
    });
  });
});

describe("withTabFirst", () => {
  it("moves the tab to the front and keeps the rest in order", () => {
    expect(withTabFirst(["files", "changes", "mockups"], "mockups")).toEqual([
      "mockups",
      "files",
      "changes",
    ]);
    expect(withTabFirst(["mockups", "files"], "mockups")).toEqual(["mockups", "files"]);
  });
});
