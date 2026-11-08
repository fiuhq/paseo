import { describe, expect, it } from "bun:test";
import { agentTone } from "./tree";

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
