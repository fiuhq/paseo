/**
 * Stop a Paseo Claude agent without archiving it (operator, 2026-10-28: "don't ever auto archive, just stop
 * it", the way a usage limit stops a turn; only the operator archives).
 *
 * Paseo 0.13's plugin API can archive an agent but cannot cancel, close or reload one. What it can do is end
 * the session's own `claude` process: Paseo then fails the turn with "Claude stopped unexpectedly", and the
 * agent stays in the sidebar with that error. Its next prompt starts a fresh process WITHOUT going through
 * `agent.session_open`, so a plugin that must keep the agent stopped calls this again on `agent.turn_started`.
 *
 * Node builtins only: plugins run as bare TypeScript with no node_modules. Paseo builds a plugin's server half
 * only from its own client/, server/ and shared/ directories, so workspace-agent-guard carries an identical copy
 * (this plugin's tests run against both).
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Claude session id an agent record persists, or null when it names none yet. */
export function sessionIdOf(record: string): string | null {
  try {
    const id = JSON.parse(record)?.persistence?.sessionId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The pids, from `ps -ax -o pid=,command=`, of the Claude processes Paseo runs for one agent: started with
 * `--output-format stream-json` and naming the agent in their Paseo MCP config (`callerAgentId=<agentId>`, on
 * every process, fresh or resumed), or, for a session with no Paseo MCP server, its session id as
 * `--resume` / `--session-id`.
 */
export function agentPids(ps: string, agentId: string, sessionId: string | null): number[] {
  const caller = new RegExp(
    `callerAgentId=${agentId.replace(/[^0-9A-Za-z-]/g, "")}(?![0-9A-Za-z-])`,
  );
  const tagged = sessionId
    ? [
        `--resume=${sessionId}`,
        `--resume ${sessionId}`,
        `--session-id ${sessionId}`,
        `--session-id=${sessionId}`,
      ]
    : [];
  return ps
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .filter(
      ([, , command]) =>
        /\bclaude\b/.test(command!) && command!.includes("--output-format stream-json"),
    )
    .filter(
      ([, , command]) => caller.test(command!) || tagged.some((tag) => command!.includes(tag)),
    )
    .map(([, pid]) => Number(pid));
}

function agentRecord(agentId: string): string | null {
  const agents = path.join(
    (process.env.PASEO_HOME ?? "~/.paseo").replace(/^~(?=$|\/)/, homedir()),
    "agents",
  );
  let dirs: string[];
  try {
    dirs = readdirSync(agents);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      return readFileSync(path.join(agents, dir, `${agentId}.json`), "utf8");
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** End the agent's Claude process. Resolves to the pids signalled; empty when none was running or found. */
export async function stopClaudeSession(agentId: string): Promise<number[]> {
  const { stdout } = await run("ps", ["-ax", "-o", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  let pids = agentPids(stdout, agentId, null);
  if (pids.length === 0) {
    const record = agentRecord(agentId);
    const sessionId = record ? sessionIdOf(record) : null;
    if (sessionId) pids = agentPids(stdout, agentId, sessionId);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  return pids;
}
