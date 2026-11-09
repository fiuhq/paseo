/** What the daemon half answers: every workspace's boards on this host, and one board's page. */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { BOARD_ID, WorkspaceBoards } from "./boards";

/** Every workspace's boards on this host, newest first, and every workspace (each gets the header button). */
export const readBoards = defineRpc({
  name: "fiu-storyboard.boards.read",
  input: z.object({}),
  output: z.object({ workspaces: WorkspaceBoards, workspaceIds: z.array(z.string()) }),
});

/** One board's page, as written; null when this host no longer has it. */
export const readBoardPage = defineRpc({
  name: "fiu-storyboard.boards.page",
  input: z.object({ board: z.string().regex(BOARD_ID) }),
  output: z.object({ html: z.string(), modifiedAt: z.number() }).nullable(),
});
