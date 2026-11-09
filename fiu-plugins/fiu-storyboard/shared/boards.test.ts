import { describe, expect, it } from "bun:test";

import { boardTitle, boardsByWorkspace, type RegistryBoard } from "./boards";

const id = (n: number) => n.toString(16).padStart(64, "0");

describe("boardsByWorkspace", () => {
  const boards: RegistryBoard[] = [
    { id: id(1), path: "/t/fiu-mockups/mockup-old-aaaaaaaa.html", owner: "agent-a" },
    { id: id(2), path: "/t/fiu-mockups/mockup-new-bbbbbbbb.html", owner: "agent-a" },
    { id: id(3), path: "/t/other/mockup-elsewhere-cccccccc.html", owner: "agent-b" },
    { id: id(4), path: "/t/orphan.html" },
    { id: id(5), path: "/t/unknown-owner.html", owner: "agent-gone" },
    { id: id(6), path: "/t/deleted.html", owner: "agent-a" },
    { id: "not-a-board-id", path: "/t/bad.html", owner: "agent-a" },
  ];
  const workspaces: Record<string, string> = { "agent-a": "ws-1", "agent-b": "ws-2" };
  const times: Record<string, number> = {
    "/t/fiu-mockups/mockup-old-aaaaaaaa.html": 100,
    "/t/fiu-mockups/mockup-new-bbbbbbbb.html": 300,
    "/t/other/mockup-elsewhere-cccccccc.html": 200,
    "/t/orphan.html": 400,
    "/t/unknown-owner.html": 500,
  };

  const grouped = boardsByWorkspace(
    boards,
    (agent) => workspaces[agent],
    (path) => times[path] ?? null,
  );

  it("puts each board under its owner's workspace, newest first", () => {
    expect(grouped["ws-1"]!.map((board) => board.id)).toEqual([id(2), id(1)]);
    expect(grouped["ws-2"]!.map((board) => board.title)).toEqual(["elsewhere"]);
  });

  it("drops a board with no owner, an owner the daemon does not know, a deleted file or a malformed id", () => {
    const listed = Object.values(grouped)
      .flat()
      .map((board) => board.id);
    expect(listed).not.toContain(id(4));
    expect(listed).not.toContain(id(5));
    expect(listed).not.toContain(id(6));
    expect(listed).not.toContain("not-a-board-id");
  });

  it("keeps only the newest boards of a workspace", () => {
    const many = Array.from(
      { length: 5 },
      (_, n): RegistryBoard => ({ id: id(10 + n), path: `/t/b${n}.html`, owner: "agent-a" }),
    );
    const kept = boardsByWorkspace(
      many,
      () => "ws-1",
      (path) => Number(path.match(/b(\d)/)![1]),
      2,
    );
    expect(kept["ws-1"]!.map((board) => board.name)).toEqual(["b4.html", "b3.html"]);
  });
});

describe("boardTitle", () => {
  it("reads a fiu mock export's label", () => {
    expect(boardTitle("mockup-refused-balance-needed-228d0ad1.html")).toBe(
      "refused balance needed",
    );
  });
  it("keeps any other board's name", () => {
    expect(boardTitle("storyboard-e2e-ledger.html")).toBe("storyboard-e2e-ledger");
    expect(boardTitle("mockup-228d0ad1.html")).toBe("mockup-228d0ad1");
  });
});
