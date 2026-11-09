import type {
  PluginClientContext,
  PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";

import { openStoryboard, STORYBOARD_PANEL, syncStoryboardButtons } from "./client/header";
import { makeStoryboardPanel } from "./client/panel";
import { BoardsStore, readBoardsInto } from "./client/store";

/**
 * fiu.Storyboard: each workspace's newest `fiu mock` or `fiu sb` board, live in a panel beside the chat. It opens from
 * the fiu.Storyboard button in the workspace's header, the Command Center or a pane's + menu, and from nothing else.
 */
export default function contribute(client: PluginClientContext) {
  const boards = new BoardsStore();
  const cleanups = [
    readBoardsInto(boards, client),
    client.addWorkspacePanel(storyboardPanel(boards)),
    syncStoryboardButtons(boards, client),
    client.addCommandCenterItem({
      id: "show-storyboard",
      title: "Show fiu.Storyboard",
      icon: "PanelRightOpen",
      keywords: [
        "fiu",
        "mock",
        "mockup",
        "mockups",
        "board",
        "storyboard",
        "design",
        "sidebar",
        "explorer",
      ],
      context: "workspace",
      onSelect: (context) => openStoryboard(client, context.workspace.id),
    }),
  ];
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
}

/**
 * The panel, the Explorer's default tab (`explorerDefault`, a fiuhq/paseo seam): when the reader opens the Explorer, it
 * shows first. Declaring it never opens the Explorer.
 */
function storyboardPanel(boards: BoardsStore): PluginWorkspacePanelContribution {
  return {
    id: STORYBOARD_PANEL,
    title: "fiu.Storyboard",
    icon: "PanelRightOpen",
    context: "workspace",
    locations: ["explorer", "workspace"],
    explorerDefault: true,
    Component: makeStoryboardPanel(boards),
  };
}
