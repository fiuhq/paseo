export type Tone = "running" | "attention" | "failed" | "idle" | "closed";

/** One colour per agent state, attention first: an agent waiting on you matters more than one working. */
export function agentTone(agent: {
  readonly status: "initializing" | "idle" | "running" | "error" | "closed";
  readonly requiresAttention: boolean;
  readonly attentionReason: "finished" | "error" | "permission" | null;
}): Tone {
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.requiresAttention) return "attention";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.status === "closed") return "closed";
  return "idle";
}
