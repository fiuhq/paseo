/**
 * The fiu.Storyboard button in the header of every workspace. Pressing it opens the panel in the Explorer beside the
 * chat. Nothing else opens the panel: no reading, mount or new board ever does, so the Explorer opens only when the
 * reader asks for it.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

import type { BoardsStore } from "./store";

export const STORYBOARD_PANEL = "storyboard";

/** Open the panel in `workspaceId`'s Explorer: only ever from a press, since opening navigates to that workspace. */
export function openStoryboard(
  client: Pick<PluginClientContext, "openPanel">,
  workspaceId: string,
): void {
  client.openPanel(STORYBOARD_PANEL, { workspaceId, location: "explorer" });
}

/** Keep one header button on each of the host's workspaces. Returns the cleanup that removes them all. */
export function syncStoryboardButtons(
  store: BoardsStore,
  client: Pick<PluginClientContext, "openPanel" | "addHeaderButton">,
): () => void {
  const buttons = new Map<string, { remove(): void }>();
  const sync = () => {
    const { workspaces, workspaceIds } = store.get();
    if (!workspaces) return;
    const wanted = new Set(workspaceIds);
    for (const [workspaceId, button] of buttons) {
      if (wanted.has(workspaceId)) continue;
      button.remove();
      buttons.delete(workspaceId);
    }
    for (const workspaceId of wanted) {
      if (buttons.has(workspaceId)) continue;
      buttons.set(
        workspaceId,
        client.addHeaderButton({
          id: STORYBOARD_PANEL,
          workspaceId,
          button: {
            title: "fiu.Storyboard",
            icon: "PanelRightOpen",
            behavior: { kind: "action", onPress: () => openStoryboard(client, workspaceId) },
          },
        }),
      );
    }
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
