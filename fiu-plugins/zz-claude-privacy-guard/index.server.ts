/**
 * Daemon half — runs on the HOST, outside Claude Code.
 *
 * THE INVARIANT: a Claude agent never sends a prompt through a work organisation that can read it. Only
 * a personal login, a non-Anthropic gateway, or a Team login with no managed settings pushed may carry one.
 *
 * An organisation can read Claude Code prompts through settings it pushes (OpenTelemetry prompt
 * logging, hooks, a proxy) or, on Enterprise, through the Compliance API, which captures transcripts as
 * they reach Anthropic and leaves no trace on the machine. Agent SDK sessions (every Paseo agent) apply
 * pushed hooks and env without the approval dialog a terminal shows, so the check runs here, where no
 * pushed setting can switch it off.
 *
 * THREE LAYERS:
 *  1. `agent.session_open` BEFORE-hook — a throw aborts the open (create, resume, refresh), so a
 *     refused session never starts and never sends a prompt.
 *  2. The login watch — a running Claude Code process picks up a new login within about 30 seconds
 *     (`claude /login`, an account switcher), so when `.claude.json` names a different account every live
 *     Claude agent is re-checked at once and the refused ones are stopped (see STOPPING).
 *  3. `agent.turn_ended` — settings refresh hourly inside a running session, so each finished turn
 *     re-checks, and a session that now fails is stopped before its next prompt.
 *
 * STOPPING, never archiving (operator, 2026-10-28: "don't ever auto archive, just stop it"; only the operator
 * archives): the guard ends the session's Claude process (server/stop-session.ts), so the turn fails the
 * way a usage limit stops one and the agent stays in the sidebar. A later prompt starts a fresh process
 * without reopening the session, so `agent.turn_started` re-checks a stopped agent and stops it again until
 * its login is allowed.
 *
 * Logs: `paseo plugin logs zz-claude-privacy-guard`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { stopClaudeSession } from "./server/stop-session";
import {
  claudeLineage,
  decide,
  freshRemoteSettings,
  loginIdentity,
  type AuthStatus,
  type ProviderEntry,
  type Verdict,
} from "./shared/privacy.core";

const run = promisify(execFile);
type Paseo = Parameters<Parameters<PluginServerContext["before"]>[1]>[1]["paseo"];
const TAG = "[zz-claude-privacy-guard]";
const CLAUDE_TIMEOUT_MS = 30_000;
// ponytail: one verdict per env for a minute, so a burst of turns spawns one `claude doctor`; drop if a check must be per turn.
const VERDICT_TTL_MS = 60_000;

const ENDPOINT_POLICIES =
  process.platform === "darwin"
    ? [
        "/Library/Application Support/ClaudeCode/managed-settings.json",
        "/Library/Application Support/ClaudeCode/managed-settings.d",
        "/Library/Application Support/ClaudeCode/managed-mcp.json",
        "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`,
      ]
    : [
        "/etc/claude-code/managed-settings.json",
        "/etc/claude-code/managed-settings.d",
        "/etc/claude-code/managed-mcp.json",
      ];

const onWsl = () =>
  Boolean(process.env.WSL_DISTRO_NAME) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

/** Windows admin policies a WSL Claude Code can inherit: the system-directory files and the HKLM key. */
async function windowsPolicies(): Promise<string[]> {
  const dir = await run("wslpath", ["-u", "C:\\Program Files\\ClaudeCode"])
    .then((out) => out.stdout.trim() || "/mnt/c/Program Files/ClaudeCode")
    .catch(() => "/mnt/c/Program Files/ClaudeCode");
  const found = ["managed-settings.json", "managed-settings.d", "managed-mcp.json"]
    .map((f) => path.join(dir, f))
    .filter((p) => existsSync(p));
  const key = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
  if (
    await run("reg.exe", ["query", key]).then(
      () => true,
      () => false,
    )
  )
    found.push(key);
  return found;
}

async function endpointPolicies(): Promise<string[]> {
  const local = ENDPOINT_POLICIES.filter((p) => existsSync(p));
  return onWsl() ? [...local, ...(await windowsPolicies())] : local;
}

function paseoProviders(): Record<string, ProviderEntry> | null {
  const home = (process.env.PASEO_HOME ?? "~/.paseo").replace(/^~(?=$|\/)/, homedir());
  try {
    const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
    return config?.agents?.providers ?? {};
  } catch {
    return null;
  }
}

/** The env a Claude session runs with, or null when the provider is not Claude. */
function claudeSessionEnv(
  provider: string,
  requestEnv: Record<string, string>,
): NodeJS.ProcessEnv | null {
  const providers = paseoProviders();
  // An unreadable Paseo config cannot say which providers extend claude, so every session is checked.
  const lineage = providers ? claudeLineage(providers, provider) : { isClaude: true, env: {} };
  if (!lineage.isClaude) return null;
  return { ...process.env, ...lineage.env, ...requestEnv };
}

async function claude(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const pending = run("claude", args, { env, cwd: tmpdir(), timeout: CLAUDE_TIMEOUT_MS });
  pending.child.stdin?.end();
  try {
    return (await pending).stdout;
  } catch (error: unknown) {
    // `claude doctor` exits non-zero when it finds an issue and still prints its report.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.length > 0) return stdout;
    throw error;
  }
}

const readOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The settings cache Claude Code keeps for the login, when it was synced at or after `since`; otherwise null. */
function remoteSettingsSince(env: NodeJS.ProcessEnv, since: number): unknown {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return freshRemoteSettings(
    readOrNull(path.join(dir, "remote-settings.json.synced-at")),
    since,
    readOrNull(path.join(dir, "remote-settings.json")),
  );
}

async function check(env: NodeJS.ProcessEnv): Promise<Verdict> {
  const since = Date.now();
  const [auth, doctor] = await Promise.all([
    claude(["auth", "status"], env)
      .then((out) => JSON.parse(out) as AuthStatus)
      .catch(() => null),
    claude(["doctor"], env).catch(() => null),
  ]);
  return decide({
    auth,
    doctor,
    baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    endpointPolicies: await endpointPolicies(),
    freshRemoteSettings: remoteSettingsSince(env, since),
  });
}

const verdicts = new Map<string, { at: number; verdict: Promise<Verdict> }>();

/** The file Claude Code records the signed-in account in. */
const CLAUDE_JSON = path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
const LOGIN_SETTLE_MS = 300;

function currentLogin(): string | null {
  try {
    return loginIdentity(readFileSync(CLAUDE_JSON, "utf8"));
  } catch {
    return null;
  }
}

/** Every agent Paseo has not archived, page by page. */
async function liveAgents(paseo: Paseo): Promise<{ id: string; provider: string }[]> {
  const agents: { id: string; provider: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(
      ...page.entries.map((entry) => ({ id: entry.agent.id, provider: entry.agent.provider })),
    );
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return agents;
}

function cachedCheck(env: NodeJS.ProcessEnv): Promise<Verdict> {
  const key = JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const hit = verdicts.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.verdict;
  const verdict = check(env);
  verdicts.set(key, { at: Date.now(), verdict });
  return verdict;
}

export default function contribute(server: PluginServerContext) {
  // The resolved env each open session was checked with, so a turn re-check reads the same account.
  const sessionEnv = new Map<string, NodeJS.ProcessEnv>();
  // ponytail: plugins get the Paseo API only inside a hook, so the watch borrows the last one a hook saw.
  let paseoApi: Paseo | null = null;

  // Agents the guard stopped; each new turn of theirs is re-checked and stopped again while still refused.
  const stopped = new Set<string>();

  async function stopIfRefused(
    agent: { id: string; provider: string },
    when: string,
  ): Promise<void> {
    const env = sessionEnv.get(agent.id) ?? claudeSessionEnv(agent.provider, {});
    if (!env) return;
    const verdict = await cachedCheck(env);
    if (verdict.allow) {
      stopped.delete(agent.id);
      return;
    }
    stopped.add(agent.id);
    const pids = await stopClaudeSession(agent.id);
    console.error(
      `${TAG} stopped ${agent.provider} agent ${agent.id} ${when} (${pids.length ? `pid ${pids.join(", ")}` : "no Claude process running"}): ${verdict.why}`,
    );
  }

  let login = currentLogin();
  let settle: NodeJS.Timeout | undefined;

  server.before("agent.session_open", async ({ request }, { paseo }) => {
    paseoApi = paseo;
    const env = claudeSessionEnv(request.provider, request.env);
    if (!env) return;
    const verdict = await check(env);
    if (!verdict.allow) {
      console.error(
        `${TAG} refused ${request.provider} session ${request.agentId} (${request.reason}): ${verdict.why}`,
      );
      throw new Error(`Claude privacy guard: ${verdict.why}`);
    }
    sessionEnv.set(request.agentId, env);
    stopped.delete(request.agentId);
  });

  // A stopped agent's next prompt runs in a fresh process that never reopens the session. Paseo hands the
  // prompt to that process before this event fires, so end it first and re-check after: a slow check here is a
  // prompt that reaches Anthropic.
  server.on("agent.turn_started", (event, { paseo }) => {
    paseoApi = paseo;
    if (!stopped.has(event.agent.id)) return;
    void (async () => {
      const pids = await stopClaudeSession(event.agent.id);
      console.error(
        `${TAG} stopped ${event.agent.provider} agent ${event.agent.id} as its next turn started (${pids.length ? `pid ${pids.join(", ")}` : "no Claude process running"})`,
      );
      await stopIfRefused(event.agent, "on its turn-start re-check");
    })().catch((error: unknown) => {
      console.error(`${TAG} turn-start stop failed for ${event.agent.id}: ${String(error)}`);
    });
  });

  server.on("agent.turn_ended", (event, { paseo }) => {
    paseoApi = paseo;
    void stopIfRefused(event.agent, "before its next prompt").catch((error: unknown) => {
      console.error(`${TAG} turn re-check failed for ${event.agent.id}: ${String(error)}`);
    });
  });

  server.on("agent.archived", (event) => {
    sessionEnv.delete(event.agent.id);
    stopped.delete(event.agent.id);
  });

  async function onLoginWrite(): Promise<void> {
    const next = currentLogin();
    if (next === login) return;
    login = next;
    verdicts.clear();
    if (!paseoApi) {
      console.error(
        `${TAG} the Claude login changed before any agent event reached this plugin, so running agents were not re-checked; new sessions are still checked when they open`,
      );
      return;
    }
    const paseo = paseoApi;
    let agents: { id: string; provider: string }[];
    try {
      agents = await liveAgents(paseo);
    } catch (error: unknown) {
      console.error(
        `${TAG} could not list agents after the Claude login changed: ${String(error)}`,
      );
      return;
    }
    const results = await Promise.allSettled(
      agents.map((agent) => stopIfRefused(agent, "when the Claude login changed")),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected")
        console.error(
          `${TAG} re-check failed for ${agents[i].id} after the Claude login changed: ${String(result.reason)}`,
        );
    });
  }

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(path.dirname(CLAUDE_JSON), (_event, name) => {
      if (name !== path.basename(CLAUDE_JSON)) return;
      clearTimeout(settle);
      settle = setTimeout(() => void onLoginWrite(), LOGIN_SETTLE_MS);
    });
    watcher.on("error", (error: unknown) => {
      console.error(
        `${TAG} the Claude login watch failed, so a login change no longer stops running agents; sessions are still checked when they open and after each turn: ${String(error)}`,
      );
    });
  } catch (error: unknown) {
    console.error(
      `${TAG} could not watch ${path.dirname(CLAUDE_JSON)} for Claude login changes; sessions are still checked when they open and after each turn: ${String(error)}`,
    );
  }

  return () => {
    watcher?.close();
    clearTimeout(settle);
  };
}
