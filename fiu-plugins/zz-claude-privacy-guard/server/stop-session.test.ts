import { describe, expect, test } from "bun:test";
import * as own from "./stop-session";
// workspace-agent-guard carries an identical copy (Paseo builds a plugin only from its own directories).
import * as copy from "../../workspace-agent-guard/server/stop-session";

const AGENT = "6436aec1-7522-4e83-993a-fb21b341946f";
const SID = "41f85d15-b779-4ec8-a102-837a1943b8c7";
const mcp = (agent: string) =>
  `--mcp-config {"mcpServers":{"paseo":{"type":"http","url":"http://127.0.0.1:6767/mcp/agents?callerAgentId=${agent}"}}}`;
// Shapes measured 2026-10-28 from `ps -ax -o pid=,command=` on the Mac.
const ps = [
  `43604 /Users/fiu/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --effort xhigh --resume=${SID} ${mcp(AGENT)}`,
  `43551 /Users/fiu/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --resume=09fd090e-eb1d-4c5e-9a3a-000000000000 ${mcp("2829a575-b9ef-404c-8ed8-86b8e1beb046")}`,
  // A new agent's first process: no --resume or --session-id yet, only its id in the MCP config.
  `50001 /Users/fiu/.local/bin/claude --output-format stream-json --input-format stream-json --effort xhigh ${mcp(AGENT)}`,
  `50002 grep -- callerAgentId=${AGENT}`,
  `50003 fiu session resume ${SID}`,
  `50004 /Users/fiu/.local/bin/claude --resume=${SID}`,
  `50005 /Users/fiu/.local/bin/claude --output-format stream-json --input-format stream-json ${mcp(`${AGENT}0`)}`,
  `50006 /Users/fiu/.local/bin/claude --output-format stream-json --input-format stream-json --session-id ${SID}`,
].join("\n");

for (const [name, { agentPids, sessionIdOf }] of [
  ["zz-claude-privacy-guard", own],
  ["workspace-agent-guard", copy],
] as const) {
  describe(`${name}: agentPids`, () => {
    test("finds the agent's Paseo Claude processes by its id, fresh or resumed", () => {
      expect(agentPids(ps, AGENT, null)).toEqual([43604, 50001]);
    });

    test("falls back to the session id for a process with no Paseo MCP config", () => {
      expect(agentPids(ps, "no-mcp-agent", SID)).toEqual([43604, 50006]);
    });

    test("never matches another agent, a longer id, a shell naming the id, or an interactive claude", () => {
      const pids = agentPids(ps, AGENT, SID);
      for (const pid of [43551, 50002, 50003, 50004, 50005]) expect(pids).not.toContain(pid);
      expect(agentPids(ps, "00000000-0000-0000-0000-000000000000", null)).toEqual([]);
    });
  });

  describe(`${name}: sessionIdOf`, () => {
    test("reads persistence.sessionId from an agent record", () => {
      expect(
        sessionIdOf(
          JSON.stringify({ id: "a", persistence: { provider: "claude", sessionId: SID } }),
        ),
      ).toBe(SID);
    });

    test("is null for a record with no session yet, or one that is not JSON", () => {
      expect(sessionIdOf(JSON.stringify({ id: "a", persistence: null }))).toBeNull();
      expect(sessionIdOf("{")).toBeNull();
    });
  });
}
