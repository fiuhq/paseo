import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type AgentPlace, HostBoards, PAGE_LIMIT_BYTES, readAllPages } from "./boards";
import { boardPathOf, ownersFileOf, registeredBoards, workspaceOfBoardFile } from "./registry";

const dir = mkdtempSync(path.join(tmpdir(), "fiu-storyboard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function readJson(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Record a board the way fiu's writer does: `boards.json` maps id → path, `boards.owners.json` id → agent. */
function record(file: string, registry: string, owner?: string): string {
  const id = createHash("sha256").update(path.resolve(file)).digest("hex");
  writeFileSync(registry, JSON.stringify({ ...readJson(registry), [id]: path.resolve(file) }));
  if (owner)
    writeFileSync(
      ownersFileOf(registry),
      JSON.stringify({ ...readJson(ownersFileOf(registry)), [id]: owner }),
    );
  return id;
}

function board(name: string, owner: string | undefined, registry: string, at: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, `<html><body>${name}</body></html>`);
  utimesSync(file, at, at);
  return record(file, registry, owner);
}

describe("HostBoards", () => {
  it("lists each workspace's boards from the registry, by the agent that wrote each", async () => {
    const registry = path.join(dir, "boards-a.json");
    const older = board("mockup-first-aaaaaaaa.html", "agent-1", registry, 1_000);
    const newer = board("mockup-second-bbbbbbbb.html", "agent-1", registry, 2_000);
    board("mockup-theirs-cccccccc.html", "agent-2", registry, 1_500);
    board("mockup-nobody-dddddddd.html", undefined, registry, 3_000);
    const boards = new HostBoards(
      async () => [
        { id: "agent-1", workspaceId: "ws-1" },
        { id: "agent-2", workspaceId: "ws-2" },
      ],
      registry,
    );
    const { workspaces } = await boards.read();
    expect(workspaces["ws-1"]!.map((b) => b.id)).toEqual([newer, older]);
    expect(workspaces["ws-1"]![0]!.title).toBe("second");
    expect(workspaces["ws-2"]!.map((b) => b.title)).toEqual(["theirs"]);
    expect(Object.keys(workspaces).sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("reads the agents again for a board whose owner it has not asked about, and not again for one it could not place", async () => {
    const registry = path.join(dir, "boards-b.json");
    board("mockup-one-aaaaaaaa.html", "agent-1", registry, 1_000);
    let reads = 0;
    let agents: AgentPlace[] = [{ id: "agent-1", workspaceId: "ws-1" }];
    const boards = new HostBoards(async () => {
      reads++;
      return agents;
    }, registry);
    await boards.read();
    expect(reads).toBe(1);
    agents = [...agents, { id: "agent-new", workspaceId: "ws-9" }];
    board("mockup-two-bbbbbbbb.html", "agent-new", registry, 2_000);
    expect((await boards.read()).workspaces["ws-9"]).toHaveLength(1);
    expect(reads).toBe(2);
    board("mockup-ghost-cccccccc.html", "agent-deleted", registry, 3_000);
    await boards.read();
    await boards.read();
    expect(reads).toBe(3);
  });

  it("serves a page only by a board id the registry names", () => {
    const registry = path.join(dir, "boards-c.json");
    const named = board("mockup-page-aaaaaaaa.html", "agent-1", registry, 1_000);
    const boards = new HostBoards(async () => [], registry);
    expect(boards.page(named)?.html).toContain("mockup-page-aaaaaaaa.html");
    expect(boards.page("0".repeat(64))).toBeNull();
    expect(boards.page("../../etc/passwd")).toBeNull();
  });

  it("refuses a page over the limit, saying what to do instead", () => {
    const registry = path.join(dir, "boards-d.json");
    const big = board("mockup-big-aaaaaaaa.html", "agent-1", registry, 1_000);
    writeFileSync(path.join(dir, "mockup-big-aaaaaaaa.html"), Buffer.alloc(PAGE_LIMIT_BYTES + 1));
    expect(() => new HostBoards(async () => [], registry).page(big)).toThrow(
      /open it as a file tab/,
    );
  });

  it("places a workspace's own board by its path, with no agent to ask, and lists every workspace", async () => {
    const registry = path.join(dir, "boards-e.json");
    const workspaceBoards = path.join(dir, "workspace-boards");
    const file = path.join(workspaceBoards, "wks_abc123", "mockups.html");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "<html></html>");
    const own = record(file, registry, "agent-gone");
    const boards = new HostBoards(
      async () => [],
      registry,
      Date.now,
      async () => ["wks_abc123", "wks_empty"],
      workspaceBoards,
    );
    const { workspaces, workspaceIds } = await boards.read();
    expect(workspaces["wks_abc123"]!.map((b) => [b.id, b.title])).toEqual([[own, "mockups"]]);
    expect(workspaceIds.sort()).toEqual(["wks_abc123", "wks_empty"]);
  });

  it("reads the workspaces at most once a minute, and again with the agents for a new owner", async () => {
    const registry = path.join(dir, "boards-f.json");
    board("mockup-one-aaaaaaaa.html", "agent-1", registry, 1_000);
    let now = 1_000_000;
    let listings = 0;
    let ids = ["ws-1"];
    const boards = new HostBoards(
      async () => [
        { id: "agent-1", workspaceId: "ws-1" },
        { id: "agent-new", workspaceId: "ws-2" },
      ],
      registry,
      () => now,
      async () => {
        listings++;
        return ids;
      },
    );
    await boards.read();
    await boards.read();
    now += 59_000;
    await boards.read();
    expect(listings).toBe(1);

    ids = ["ws-1", "ws-2"];
    board("mockup-two-bbbbbbbb.html", "agent-new", registry, 2_000);
    expect((await boards.read()).workspaceIds.sort()).toEqual(["ws-1", "ws-2"]);
    expect(listings).toBe(2);

    ids = ["ws-1", "ws-2", "ws-3"];
    now += 60_000;
    expect((await boards.read()).workspaceIds.sort()).toEqual(["ws-1", "ws-2", "ws-3"]);
    expect(listings).toBe(3);
  });
});

describe("the registry, read only", () => {
  it("reads nothing from a missing or malformed registry", () => {
    expect(registeredBoards(path.join(dir, "missing.json"))).toEqual([]);
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "[1,2]");
    expect(registeredBoards(bad)).toEqual([]);
    expect(boardPathOf("0".repeat(64), bad)).toBeNull();
  });

  it("names the owners file beside the registry", () => {
    expect(ownersFileOf("/h/.fiu/boards.json")).toBe("/h/.fiu/boards.owners.json");
  });

  it("reads a workspace back from its own board's path only", () => {
    expect(workspaceOfBoardFile("/b/wks_1/mockups.html", "/b")).toBe("wks_1");
    expect(workspaceOfBoardFile("/b/wks_1/other.html", "/b")).toBeUndefined();
    expect(workspaceOfBoardFile("/b/../etc/mockups.html", "/b")).toBeUndefined();
    expect(workspaceOfBoardFile("/elsewhere/wks_1/mockups.html", "/b")).toBeUndefined();
  });
});

describe("readAllPages — a list the daemon pages 200 at a time, read to its end", () => {
  const daemon = (total: number) => {
    const asked: { limit: number; cursor?: string }[] = [];
    const read = async (page: { limit: number; cursor?: string }) => {
      asked.push(page);
      const start = page.cursor ? Number(page.cursor) : 0;
      const end = Math.min(start + page.limit, total);
      const entries = Array.from({ length: end - start }, (_, i) => `ws${start + i}`);
      return {
        entries,
        pageInfo: { hasMore: end < total, nextCursor: end < total ? String(end) : null },
      };
    };
    return { asked, read };
  };

  it("reads every page past the first, so the 201st workspace is not lost", async () => {
    const { asked, read } = daemon(450);
    const ids = await readAllPages(read, 5_000);
    expect(ids).toHaveLength(450);
    expect(ids.at(-1)).toBe("ws449");
    expect(asked).toEqual([
      { limit: 200 },
      { limit: 200, cursor: "200" },
      { limit: 200, cursor: "400" },
    ]);
  });

  it("stops at the cap", async () => {
    const { asked, read } = daemon(10_000);
    expect(await readAllPages(read, 400)).toHaveLength(400);
    expect(asked).toHaveLength(2);
  });
});
