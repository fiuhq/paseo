# fiu.Storyboard

Each Paseo workspace's newest board (`fiu mock`, `fiu sb`, `fiu e2e`, `fiu showcase`), live in a panel beside the chat.

## Opening it

The panel opens only when you open it:

- the **fiu.Storyboard** button in a workspace's header;
- **Show fiu.Storyboard** in the Command Center;
- **fiu.Storyboard** in a pane's + menu.

It is the Explorer's default tab (`explorerDefault`), so opening the Explorer (Cmd+E) shows it first. No reading,
mount or new board ever opens the panel or the Explorer: `openPanel` navigates to its workspace, so the plugin calls it
from a press only.

## What it shows

The workspace's newest board, in a sandboxed frame with its scripts on, the way Paseo's HTML preview runs it (no
`allow-same-origin`, a `data:` URL so the board has no origin of its own). Older and newer step through the
workspace's last 30 boards; a `--watch` rerun redraws in place. A board over 40 MB stays a file tab. On a phone the
panel says to open the workspace in the web or desktop app.

A board belongs to a workspace when it is the workspace's own (`~/.fiu/workspace-boards/<workspace id>/mockups.html`)
or when the Paseo agent that wrote it works in that workspace.

## Where the boards come from

fiu's board registry, read only (`server/registry.ts`): `~/.fiu/boards.json` (board id → file) and
`~/.fiu/boards.owners.json` (board id → the agent that wrote it). fiu writes both as each board lands; its writer in
fiuhq/core (`packages/fiu-cli/paseo-plugin/server/board-registry.ts`) owns the format. A board's sticky notes are kept
by fiu's own Paseo plugin (`fiu-cli`), whose bridge hears the board's frame wherever it runs.

The client re-reads every 4 seconds while the page is visible (the SDK has no daemon-pushed subscription), one read
for every open workspace. The plugin keeps no state.

## Checking it

`bun run verify` in this directory, after the repository-root setup in [`../README.md`](../README.md).
