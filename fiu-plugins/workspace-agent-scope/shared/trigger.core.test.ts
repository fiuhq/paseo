import { expect, test } from "bun:test";
import path from "node:path";

import { CoalescingRunner, whenRemoved, type RemovalPorts } from "./trigger.core";

test("events that arrive during a run collapse into exactly one follow-up run", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const runner = new CoalescingRunner(async () => {
    runs += 1;
    if (runs === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const first = runner.request();
  await runner.request();
  await runner.request();
  await runner.request();
  release();
  await first;
  expect(runs).toBe(2);
});

test("a request after a run has finished starts a new run", async () => {
  let runs = 0;
  const runner = new CoalescingRunner(async () => {
    runs += 1;
  });
  await runner.request();
  await runner.request();
  expect(runs).toBe(2);
});

test("a failing run does not wedge the runner", async () => {
  let runs = 0;
  const runner = new CoalescingRunner(async () => {
    runs += 1;
    if (runs === 1) throw new Error("boom");
  });
  await expect(runner.request()).rejects.toThrow("boom");
  await runner.request();
  expect(runs).toBe(2);
});

test("a request queued behind a failing run still gets its follow-up run", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const runner = new CoalescingRunner(async () => {
    runs += 1;
    if (runs === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("first run failed");
    }
  });
  const first = runner.request();
  await runner.request();
  release();
  await expect(first).rejects.toThrow("first run failed");
  expect(runs).toBe(2);
});

/** A directory tree held in memory, with watches that a test fires by removing an entry. */
function fakeTree(paths: string[]) {
  const present = new Set(paths);
  const watches = new Map<string, { onChange: () => void; onError: (error: Error) => void }>();
  const ports: RemovalPorts = {
    exists: (dir) => present.has(dir),
    parent: (dir) => dir.slice(0, dir.lastIndexOf("/")) || "/",
    watch: (dir, onChange, onError) => {
      watches.set(dir, { onChange, onError });
      return () => void watches.delete(dir);
    },
  };
  const remove = (dir: string) => {
    present.delete(dir);
    watches.get(path.dirname(dir))?.onChange();
  };
  return { ports, watches, remove, present };
}

test("an archive's run waits for its worktree to be removed, and runs once it is", () => {
  const tree = fakeTree(["/wt/h", "/wt/h/a", "/wt/h/b"]);
  let runs = 0;
  whenRemoved(
    "/wt/h/a",
    tree.ports,
    () => void (runs += 1),
    (error) => {
      throw error;
    },
  );
  tree.remove("/wt/h/b");
  expect(runs).toBe(0);
  tree.remove("/wt/h/a");
  expect(runs).toBe(1);
  expect(tree.watches.size).toBe(0);
});

test("a worktree already gone runs at once, and one that stays never runs", () => {
  const tree = fakeTree(["/wt/h", "/wt/h/kept"]);
  let runs = 0;
  whenRemoved(
    "/wt/h/gone",
    tree.ports,
    () => void (runs += 1),
    (error) => {
      throw error;
    },
  );
  expect(runs).toBe(1);
  const stop = whenRemoved(
    "/wt/h/kept",
    tree.ports,
    () => void (runs += 1),
    (error) => {
      throw error;
    },
  );
  expect(runs).toBe(1);
  stop();
  expect(tree.watches.size).toBe(0);
});

test("a watch that breaks ends the wait with its error, once", () => {
  const tree = fakeTree(["/wt/h", "/wt/h/a"]);
  const errors: string[] = [];
  let runs = 0;
  whenRemoved(
    "/wt/h/a",
    tree.ports,
    () => void (runs += 1),
    (error) => void errors.push(error.message),
  );
  tree.watches.get("/wt/h")!.onError(new Error("EMFILE"));
  tree.remove("/wt/h/a");
  expect({ runs, errors }).toEqual({ runs: 0, errors: ["EMFILE"] });
});
