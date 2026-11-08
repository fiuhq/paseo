/**
 * Pure half of zz-claude-privacy-guard: decide, from facts the daemon half gathered, whether a Claude
 * session may send prompts. A prompt may only leave through a personal login, a non-Anthropic gateway,
 * or a Team login whose organisation pushes no managed settings. Enterprise (whose Compliance API
 * reads transcripts with nothing on the machine) and anything unnamed never receive one.
 *
 * Every unknown is a refusal. The guard allows only what it can name: a personal login, or a Team one with
 * nothing pushed.
 */

/** The fields of `claude auth status` the verdict reads. */
export interface AuthStatus {
  readonly loggedIn?: boolean;
  readonly authMethod?: string;
  readonly apiProvider?: string;
  readonly subscriptionType?: string;
  readonly orgName?: string;
}

export interface PrivacyFacts {
  /** Parsed `claude auth status`, or null when it could not be read. */
  readonly auth: AuthStatus | null;
  /** `claude doctor` output, or null when it could not be run. */
  readonly doctor: string | null;
  /** The `ANTHROPIC_BASE_URL` the session runs with, if any. */
  readonly baseUrl: string | undefined;
  /** Admin policy files and profiles present on this machine (managed-settings.json, MDM). */
  readonly endpointPolicies: readonly string[];
  /**
   * The parsed `remote-settings.json` Claude Code cached, only when it was synced during this check (doctor's own
   * fetch writes it after doctor prints); otherwise null.
   */
  readonly freshRemoteSettings?: unknown;
}

export type Verdict = { readonly allow: boolean; readonly why: string };

const PERSONAL_PLANS = new Set(["free", "pro", "max"]);

const allow = (why: string): Verdict => ({ allow: true, why });
const refuse = (why: string): Verdict => ({ allow: false, why });

// `claude auth status` takes the plan (`subscriptionType`) from the stored credential and the organisation
// name from the account record in .claude.json, which an account switcher can leave stale (measured
// 2026-10-28: one config dir read `max` or `team` depending only on which credential store it was given).
// `claude doctor` reads the live credential too. This line is how doctor says the live login belongs to no
// organisation.
const PERSONAL_LIVE_LOGIN =
  /^Managed settings \(remote\):\s*not fetched\b.*\brequires an Enterprise or Team subscription\b/i;
// How doctor says a Team organisation pushes nothing: no prompt logging, hooks or proxy can reach the session.
const NOTHING_PUSHED = /^Managed settings \(remote\):\s*none configured for this organization\s*$/i;

export function remoteSettingsLine(doctor: string | null): string | null {
  const line = doctor?.split("\n").find((l) => l.trim().startsWith("Managed settings (remote):"));
  return line?.trim() ?? null;
}

// How doctor says its own fetch of the settings is still running. Each doctor run starts one and prints before it
// returns, so this is its usual answer; the cache that fetch writes is read instead (`freshRemoteSettings`).
const FETCH_PENDING = /^Managed settings \(remote\):\s*checking\b/i;

/**
 * The settings cache Claude Code wrote, parsed, only when its synced-at (ms since the epoch, as the
 * `remote-settings.json.synced-at` file holds it) is at or after `since`; null when stale, missing or unreadable.
 */
export function freshRemoteSettings(
  syncedAt: string | null,
  since: number,
  cache: string | null,
): unknown {
  if (syncedAt === null || cache === null || syncedAt.trim() === "") return null;
  const at = Number(syncedAt.trim());
  if (!Number.isFinite(at) || at < since) return null;
  try {
    return JSON.parse(cache);
  } catch {
    return null;
  }
}

const nothingPushed = (line: string | null): boolean => line !== null && NOTHING_PUSHED.test(line);

const isEmptyObject = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

/** Whether doctor answered before its settings fetch finished, so its verdict is not yet known. */
export function settingsFetchPending(doctor: string | null): boolean {
  const line = remoteSettingsLine(doctor);
  return line !== null && FETCH_PENDING.test(line);
}

export function decide(facts: PrivacyFacts): Verdict {
  // An admin policy on the machine applies to every account, personal ones included.
  if (facts.endpointPolicies.length > 0) {
    return refuse(
      `this machine carries an admin Claude Code policy (${facts.endpointPolicies.join(", ")}), which can turn on prompt logging for any account`,
    );
  }
  if (facts.baseUrl) {
    let host: string | null = null;
    try {
      host = new URL(facts.baseUrl).host;
    } catch {
      return refuse(`ANTHROPIC_BASE_URL is not a URL (${facts.baseUrl})`);
    }
    if (host !== "api.anthropic.com")
      return allow(`prompts go to ${host}, not to an Anthropic organisation`);
  }

  const auth = facts.auth;
  if (!auth)
    return refuse(
      "could not read which account Claude is signed in to (`claude auth status` failed)",
    );
  if (auth.loggedIn === false) return allow("Claude is not signed in");
  if (auth.apiProvider && auth.apiProvider !== "firstParty") {
    return allow(`prompts go to ${auth.apiProvider}, not to an Anthropic organisation`);
  }

  const plan = auth.subscriptionType;
  const line = remoteSettingsLine(facts.doctor);
  // Team has no Compliance API, so pushed settings are its only route to prompts; with none pushed it
  // sees nothing. The turn re-check catches settings pushed later.
  if (
    plan === "team" &&
    (nothingPushed(line) ||
      (settingsFetchPending(facts.doctor) && isEmptyObject(facts.freshRemoteSettings)))
  ) {
    return allow(
      `${auth.orgName ?? "the signed-in organisation"} is a Team login with no managed settings pushed`,
    );
  }
  if (!plan || !PERSONAL_PLANS.has(plan)) {
    return refuse(
      `${auth.orgName ?? "the signed-in organisation"} is a work login (plan ${plan ?? "none"}, ${auth.authMethod ?? "unknown method"}, ${line ?? "no managed-settings line"}): Paseo never sends a prompt through an organisation that can read it`,
    );
  }
  if (!line || !PERSONAL_LIVE_LOGIN.test(line)) {
    return refuse(
      `the account record says personal ${plan}, but the live login may be an organisation's (\`claude doctor\`: ${line ?? "no managed-settings line"})`,
    );
  }
  return allow(`personal ${plan} account`);
}

/** Who `.claude.json` says is signed in: organisation and email, or null when it names nobody. */
export function loginIdentity(claudeJson: string): string | null {
  try {
    const account = JSON.parse(claudeJson)?.oauthAccount;
    return account ? `${account.organizationUuid ?? ""}|${account.emailAddress ?? ""}` : null;
  } catch {
    return null;
  }
}

/** A provider entry in Paseo's `config.json` (`agents.providers.<id>`). */
export interface ProviderEntry {
  readonly extends?: string;
  readonly env?: Record<string, string>;
}

/** Paseo's built-in Claude Code provider: the root every Claude-based provider `extends`. */
const CLAUDE_ROOT = "claude";

/**
 * Whether `provider` runs Claude Code, and the env its chain of `extends` adds (closest entry wins).
 * A built-in id other than `claude` (codex, opencode, …) is not Claude. A cycle is treated as Claude.
 */
export function claudeLineage(
  providers: Readonly<Record<string, ProviderEntry>>,
  provider: string,
): { readonly isClaude: boolean; readonly env: Record<string, string> } {
  const chain: ProviderEntry[] = [];
  const seen = new Set<string>();
  let id: string | undefined = provider;
  while (id !== undefined) {
    if (seen.has(id)) return { isClaude: true, env: mergeEnv(chain) };
    seen.add(id);
    const entry: ProviderEntry | undefined = providers[id];
    if (entry) chain.push(entry);
    // fiu-guard: the walk stops at the chain's root, not a per-variant behaviour; every provider is handled alike.
    if (id === CLAUDE_ROOT) return { isClaude: true, env: mergeEnv(chain) };
    id = entry?.extends;
  }
  return { isClaude: false, env: {} };
}

function mergeEnv(chain: readonly ProviderEntry[]): Record<string, string> {
  return Object.assign({}, ...[...chain].reverse().map((entry) => entry.env ?? {}));
}
