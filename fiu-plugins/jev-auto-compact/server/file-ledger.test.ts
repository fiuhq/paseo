import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FileLedger } from "./file-ledger";

const made: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-ledger-"));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("FileLedger", () => {
  test("a key can be claimed exactly once", async () => {
    const ledger = new FileLedger(await tempDir(), null);
    expect(await ledger.claim("agent-00000001", "k1", 1)).toBe(true);
    expect(await ledger.claim("agent-00000001", "k1", 2)).toBe(false);
    expect(await ledger.claim("agent-00000001", "k2", 3)).toBe(true);
  });

  test("concurrent claims of one key produce a single winner", async () => {
    const ledger = new FileLedger(await tempDir(), null);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.claim("agent-00000001", "same", 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("two ledgers over the same directory still claim once — a reload cannot double-send", async () => {
    const dir = await tempDir();
    expect(await new FileLedger(dir, null).claim("agent-00000001", "k1", 1)).toBe(true);
    expect(await new FileLedger(dir, null).claim("agent-00000001", "k1", 2)).toBe(false);
  });

  test("every outcome is appended to the agent's log", async () => {
    const dir = await tempDir();
    const ledger = new FileLedger(dir, null);
    await ledger.settle("agent-00000001", "k1", "compacted", 1_000, 500_000);
    await ledger.settle("agent-00000001", "k2", "held", 2_000, null);
    await ledger.settle("agent-00000001", "k3", "failed", 3_000, null);

    const log = await fs.readFile(path.join(dir, "agents", "agent-00000001", "log.jsonl"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(3);
  });

  test("a claim is never forgotten, however many turns follow it", async () => {
    const ledger = new FileLedger(await tempDir(), null);
    for (let i = 0; i < 250; i++) await ledger.claim("agent-00000001", `k${i}`, i);
    expect(await ledger.claim("agent-00000001", "k0", 999)).toBe(false);
  });

  test("refuses an agent id that could escape its directory", async () => {
    const ledger = new FileLedger(await tempDir(), null);
    await expect(ledger.claim("../../etc", "k", 1)).rejects.toThrow("unusable agent id");
  });
});

/**
 * The rename gave this plugin a new home, and the claims behind "at most once" are files in
 * the old one. Every test here is the same failure said differently: a turn already acted on
 * under the pre-rename id must not be acted on again under this one.
 */
describe("FileLedger across the rename", () => {
  const AGENT = "0a22c54f-4e92-4f1b-922f-bb9663f8849f";
  const TURN = `${AGENT}#foreground-turn-8#72#78ec0aa6`;

  test("a turn claimed under the pre-rename id is not claimed a second time here", async () => {
    const legacy = await tempDir();
    const dir = await tempDir();
    expect(await new FileLedger(legacy, null).claim(AGENT, TURN, 1)).toBe(true);

    expect(await new FileLedger(dir, legacy).claim(AGENT, TURN, 2)).toBe(false);
  });

  test("and the turns it never saw stay claimable", async () => {
    const legacy = await tempDir();
    const dir = await tempDir();
    await new FileLedger(legacy, null).claim(AGENT, TURN, 1);

    const ledger = new FileLedger(dir, legacy);
    expect(await ledger.claim(AGENT, `${AGENT}#foreground-turn-9#80#0d1e2f3a`, 2)).toBe(true);
    expect(await ledger.claim(AGENT, TURN, 3)).toBe(false);
  });

  test("a second process carries nothing over twice and still refuses the old claim", async () => {
    const legacy = await tempDir();
    const dir = await tempDir();
    await new FileLedger(legacy, null).claim(AGENT, TURN, 1);
    await new FileLedger(dir, legacy).claim(AGENT, TURN, 2);

    const claims = path.join(dir, "agents", AGENT, "claims");
    const after = await fs.readdir(claims);
    expect(await new FileLedger(dir, legacy).claim(AGENT, TURN, 3)).toBe(false);
    expect(await fs.readdir(claims)).toEqual(after);
  });

  test("what this home already recorded wins: the old one cannot overwrite it", async () => {
    const legacy = await tempDir();
    const dir = await tempDir();
    const agentDir = (root: string) => path.join(root, "agents", AGENT);
    await fs.mkdir(agentDir(legacy), { recursive: true });
    await fs.writeFile(
      path.join(agentDir(legacy), "log.jsonl"),
      `${JSON.stringify({ at: 1, outcome: "compacted" })}\n`,
    );
    await fs.mkdir(agentDir(dir), { recursive: true });
    await fs.writeFile(
      path.join(agentDir(dir), "log.jsonl"),
      `${JSON.stringify({ at: 2, outcome: "held" })}\n`,
    );

    await new FileLedger(dir, legacy).claim(AGENT, TURN, 3);

    const log = JSON.parse(await fs.readFile(path.join(agentDir(dir), "log.jsonl"), "utf8"));
    expect(log).toEqual({ at: 2, outcome: "held" });
  });

  test("a pre-rename home that cannot be read fails the claim instead of winning it", async () => {
    const legacy = await tempDir();
    // A regular file where the old home's agents/ directory belongs: the real ENOTDIR shape.
    await fs.writeFile(path.join(legacy, "agents"), "not a directory");
    const ledger = new FileLedger(await tempDir(), legacy);

    await expect(ledger.claim(AGENT, TURN, 1)).rejects.toThrow();
    // Not remembered as settled either: the next turn tries the carry-over again.
    await expect(ledger.claim(AGENT, TURN, 2)).rejects.toThrow();
  });

  test("no pre-rename home at all is the ordinary case, not a failure", async () => {
    const ledger = new FileLedger(await tempDir(), path.join(await tempDir(), "never-ran-here"));
    expect(await ledger.claim(AGENT, TURN, 1)).toBe(true);
    expect(await ledger.claim(AGENT, TURN, 2)).toBe(false);
  });
});
