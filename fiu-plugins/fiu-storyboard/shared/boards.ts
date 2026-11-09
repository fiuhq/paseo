/**
 * The panel's model: which boards (`fiu mock`, `fiu sb`, `fiu e2e`, `fiu showcase` exports) belong to which workspace,
 * and what each is called. Pure; the daemon half reads fiu's board registry and the agents, the client half renders.
 *
 * A workspace's own board belongs to it by its path. Any other board belongs to the workspace of the Paseo agent that
 * wrote it: the registry records that agent as the board's owner. A board with neither, or whose owner the daemon no
 * longer knows, belongs to none.
 */
import { z } from "zod";

/** A board's id: the sha256 of where its file was written, as fiu names it. */
export const BOARD_ID = /^[0-9a-f]{64}$/;

export const Board = z.object({
  id: z.string().regex(BOARD_ID),
  /** The board's file name, as fiu printed it. */
  name: z.string(),
  /** What the panel calls it: the label the run was given. */
  title: z.string(),
  /** When the file was last written, in epoch ms: a `--watch` rerun rewrites it in place. */
  modifiedAt: z.number(),
});
export type Board = z.infer<typeof Board>;

/** Every workspace's boards, newest first, by workspace id. */
export const WorkspaceBoards = z.record(z.string(), z.array(Board));
export type WorkspaceBoards = z.infer<typeof WorkspaceBoards>;

/** How many boards a workspace's panel lists: the newest, since an old one is still a file. */
export const BOARDS_PER_WORKSPACE = 30;

/** A board the registry names: where it is and which agent wrote it. */
export interface RegistryBoard {
  readonly id: string;
  readonly path: string;
  readonly owner?: string;
}

/**
 * Every workspace's boards, newest first. `workspaceOf` names an agent's workspace (undefined: unknown); `modifiedAt`
 * reads a file's write time (null: the file is gone, so the board is not listed).
 */
export function boardsByWorkspace(
  boards: readonly RegistryBoard[],
  workspaceOf: (agentId: string) => string | undefined,
  modifiedAt: (path: string) => number | null,
  limit: number = BOARDS_PER_WORKSPACE,
  /** The workspace whose own board a path is (`<workspace boards>/<id>/mockups.html`), placed by its path. */
  boardOfWorkspace: (path: string) => string | undefined = () => undefined,
): WorkspaceBoards {
  const grouped: Record<string, Board[]> = {};
  for (const board of boards) {
    const workspace =
      boardOfWorkspace(board.path) ?? (board.owner ? workspaceOf(board.owner) : undefined);
    if (!workspace || !BOARD_ID.test(board.id)) continue;
    const at = modifiedAt(board.path);
    if (at === null) continue;
    const name = board.path.split(/[\\/]/).pop() ?? board.path;
    (grouped[workspace] ??= []).push({
      id: board.id,
      name,
      title: boardTitle(name),
      modifiedAt: at,
    });
  }
  for (const workspace of Object.keys(grouped)) {
    grouped[workspace] = grouped[workspace]!.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(
      0,
      limit,
    );
  }
  return grouped;
}

/**
 * A board's title from its file name: `mockup-refused-balance-needed-228d0ad1.html` reads "refused balance needed".
 * `fiu mock` names an export `mockup-<label slug>-<run id>`; any other board keeps its name without the extension.
 */
export function boardTitle(name: string): string {
  const base = name.replace(/\.html?$/i, "");
  const mock = /^mockup-(.+)-[0-9a-f]{8}$/.exec(base);
  if (mock) return mock[1]!.replace(/-/g, " ");
  return base;
}
