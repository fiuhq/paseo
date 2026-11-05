import { describe, expect, it } from "vitest";
import { advanceStartup, beginStartup, describeStartup, formatSeconds } from "./progress";

const begin = () =>
  beginStartup({
    serverId: "srv",
    draftId: "draft-1",
    agentLabel: "Claude",
    at: 1_000,
    isWorktree: true,
  });
const worktree = { kind: "worktree", worktreeSlug: "nice-bear" } as const;

describe("workspace startup progress", () => {
  it("shows the workspace step running from the moment of submit", () => {
    expect(describeStartup(begin())).toEqual({
      kind: "starting",
      workspace: {
        state: "running",
        seconds: null,
        since: 1_000,
        isWorktree: true,
        worktreeSlug: null,
      },
      agent: { state: "waiting", seconds: null, since: null },
    });
  });

  it("names the worktree and times it once the workspace exists", () => {
    const progress = advanceStartup(begin(), {
      phase: "workspace_ready",
      at: 5_100,
      workspace: worktree,
    });
    expect(describeStartup(progress)).toEqual({
      kind: "starting",
      workspace: {
        state: "done",
        seconds: 4.1,
        since: null,
        isWorktree: true,
        worktreeSlug: "nice-bear",
      },
      agent: { state: "running", seconds: null, since: 5_100 },
    });
  });

  it("knows a directory workspace is not a worktree", () => {
    const progress = advanceStartup(begin(), {
      phase: "workspace_ready",
      at: 1_200,
      workspace: { kind: "directory", worktreeSlug: null },
    });
    expect(describeStartup(progress)).toMatchObject({
      workspace: { state: "done", seconds: 0.2, isWorktree: false, worktreeSlug: null },
    });
  });

  it("folds into totals when the agent is ready", () => {
    let progress = advanceStartup(begin(), {
      phase: "workspace_ready",
      at: 5_100,
      workspace: worktree,
    });
    progress = advanceStartup(progress, { phase: "agent_ready", at: 6_900, agentId: "agent-1" });
    expect(describeStartup(progress)).toEqual({
      kind: "ready",
      totalSeconds: 5.9,
      workspaceSeconds: 4.1,
      agentSeconds: 1.8,
      isWorktree: true,
    });
    expect(progress.agentId).toBe("agent-1");
  });

  it("treats a later phase as covering the earlier ones it skipped", () => {
    const progress = advanceStartup(begin(), {
      phase: "completed",
      at: 4_000,
      agentId: "agent-1",
      workspace: worktree,
    });
    expect(describeStartup(progress)).toEqual({
      kind: "ready",
      totalSeconds: 3,
      workspaceSeconds: 3,
      agentSeconds: 0,
      isWorktree: true,
    });
  });

  it("keeps the first time a phase was reached when the daemon repeats it", () => {
    const first = advanceStartup(begin(), {
      phase: "workspace_ready",
      at: 2_000,
      workspace: worktree,
    });
    const repeated = advanceStartup(first, {
      phase: "workspace_ready",
      at: 9_000,
      workspace: worktree,
    });
    expect(repeated).toBe(first);
  });

  it("ignores the accepted phase", () => {
    const progress = begin();
    expect(advanceStartup(progress, { phase: "accepted", at: 1_500 })).toBe(progress);
  });

  it("labels the workspace step from the submit until the daemon reports the workspace", () => {
    const local = beginStartup({
      serverId: "srv",
      draftId: "d",
      agentLabel: "Claude",
      at: 0,
      isWorktree: false,
    });
    expect(describeStartup(local)).toMatchObject({ workspace: { isWorktree: false } });
  });
});

describe("formatSeconds", () => {
  it("drops a trailing .0 and keeps one decimal otherwise", () => {
    expect(formatSeconds(3)).toBe("3s");
    expect(formatSeconds(4.1)).toBe("4.1s");
    expect(formatSeconds(0)).toBe("0s");
  });

  it("reads like the running clock from a minute up", () => {
    expect(formatSeconds(59.9)).toBe("59.9s");
    expect(formatSeconds(60)).toBe("1m");
    expect(formatSeconds(94.2)).toBe("1m 34s");
  });
});
