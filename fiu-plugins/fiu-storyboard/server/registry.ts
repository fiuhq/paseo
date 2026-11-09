/**
 * fiu's board registry, read only. `fiu mock`, `fiu sb`, `fiu e2e` and `fiu showcase` write it as each board lands
 * (fiuhq/core `packages/fiu-cli/paseo-plugin/server/board-registry.ts` is the writer and owns the format):
 *
 * - `~/.fiu/boards.json`: `{ <board id>: <absolute path> }`;
 * - `~/.fiu/boards.owners.json`: `{ <board id>: <Paseo agent id that wrote it> }`;
 * - `~/.fiu/workspace-boards/<workspace id>/mockups.html`: a workspace's own board.
 *
 * This plugin never writes any of it.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { BOARD_ID, type RegistryBoard } from "../shared/boards";

export const BOARDS_FILE = path.join(homedir(), ".fiu", "boards.json");
export const WORKSPACE_BOARDS_DIR = path.join(homedir(), ".fiu", "workspace-boards");

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/** A JSON object of strings from `file`; empty when the file is missing or not one. */
function readMap(file: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** `boards.json` → `boards.owners.json`, beside it. */
export function ownersFileOf(registry: string): string {
  return registry.replace(/(\.json)?$/, ".owners.json");
}

/** Every board the registry names, with the agent that wrote it when recorded. */
export function registeredBoards(registry: string = BOARDS_FILE): RegistryBoard[] {
  const owners = readMap(ownersFileOf(registry));
  return Object.entries(readMap(registry)).map(([id, at]) =>
    owners[id] ? { id, path: at, owner: owners[id] } : { id, path: at },
  );
}

/** The file a board id names; null when the registry names none. */
export function boardPathOf(id: string, registry: string = BOARDS_FILE): string | null {
  if (!BOARD_ID.test(id)) return null;
  return readMap(registry)[id] ?? null;
}

/** The workspace whose own board `file` is (`<dir>/<workspace id>/mockups.html`), or undefined. */
export function workspaceOfBoardFile(
  file: string,
  dir: string = WORKSPACE_BOARDS_DIR,
): string | undefined {
  const relative = path.relative(dir, path.resolve(file)).split(path.sep);
  return relative.length === 2 && relative[1] === "mockups.html" && WORKSPACE_ID.test(relative[0]!)
    ? relative[0]
    : undefined;
}
