import { describe, expect, it } from "bun:test";
import { agentCountLabel, agentTone, isExpanded, toggled } from "./tree";

describe("workspace expansion", () => {
  it("starts collapsed and opens and closes on toggle", () => {
    expect(isExpanded([], "h/w1")).toBe(false);
    const opened = toggled([], "h/w1");
    expect(isExpanded(opened, "h/w1")).toBe(true);
    expect(toggled(opened, "h/w1")).toEqual([]);
  });

  it("leaves other workspaces as they were", () => {
    expect(toggled(["h/w1", "h/w2"], "h/w1")).toEqual(["h/w2"]);
  });
});

describe("agent tone", () => {
  const agent = { status: "idle", requiresAttention: false, attentionReason: null } as const;

  it("puts a failure before a pending question", () => {
    expect(
      agentTone({ ...agent, status: "error", requiresAttention: true, attentionReason: "error" }),
    ).toBe("failed");
  });

  it("shows an agent waiting on you over one that is working", () => {
    expect(
      agentTone({
        ...agent,
        status: "running",
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("attention");
  });

  it("reads starting as running and closed as closed", () => {
    expect(agentTone({ ...agent, status: "initializing" })).toBe("running");
    expect(agentTone({ ...agent, status: "closed" })).toBe("closed");
    expect(agentTone(agent)).toBe("idle");
  });
});

describe("agent count", () => {
  it("says agent for one and agents for more", () => {
    expect(agentCountLabel(1)).toBe("1 agent");
    expect(agentCountLabel(3)).toBe("3 agents");
  });
});
