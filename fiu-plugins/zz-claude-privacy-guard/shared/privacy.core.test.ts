import { describe, expect, test } from "bun:test";
import {
  claudeLineage,
  decide,
  freshRemoteSettings,
  loginIdentity,
  settingsFetchPending,
  type PrivacyFacts,
} from "./privacy.core";

const PERSONAL_LINE =
  "Managed settings (remote): not fetched — requires an Enterprise or Team subscription";
// Measured on a Team login, 2026-10-22.
const TEAM_NONE = "Managed settings (remote): none configured for this organization";

const facts = (over: Partial<PrivacyFacts>): PrivacyFacts => ({
  auth: {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  },
  doctor: `Claude Code doctor\n\n${PERSONAL_LINE}\nOrganization policy: not applicable to Pro and Max accounts`,
  baseUrl: undefined,
  endpointPolicies: [],
  ...over,
});
const work = (plan: string | undefined, doctor: string | null = TEAM_NONE) =>
  facts({
    auth: {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: plan,
      orgName: "Acme",
    },
    doctor,
  });

describe("decide", () => {
  test("allows a personal Max login whose live credential doctor also reads as personal", () => {
    expect(decide(facts({}))).toEqual({ allow: true, why: "personal max account" });
  });

  test("allows a Team login while its organisation pushes no managed settings", () => {
    expect(decide(work("team"))).toEqual({
      allow: true,
      why: "Acme is a Team login with no managed settings pushed",
    });
  });

  test("refuses a Team login once its organisation pushes settings, or when doctor cannot say", () => {
    for (const doctor of [
      "Managed settings (remote): 2 settings loaded",
      null,
      "Claude Code doctor\nNo installation issues found.",
    ]) {
      const v = decide(work("team", doctor));
      expect(v.allow).toBeFalse();
      expect(v.why).toContain("Acme is a work login");
    }
  });

  test("refuses Enterprise and unnamed organisation plans even with nothing pushed", () => {
    // The Compliance API returns Enterprise transcripts without any setting on the machine.
    for (const plan of ["enterprise", "business", undefined]) {
      const v = decide(work(plan));
      expect(v.allow).toBeFalse();
      expect(v.why).toContain("Acme is a work login");
    }
  });

  test("refuses a personal account record whose live credential doctor reads as an organisation's", () => {
    // An account switcher can rewrite the live credential without the record in .claude.json.
    const v = decide(facts({ doctor: TEAM_NONE }));
    expect(v.allow).toBeFalse();
    expect(v.why).toContain(TEAM_NONE);
  });

  test("refuses a personal account record when doctor cannot run or prints no managed-settings line", () => {
    expect(decide(facts({ doctor: null })).allow).toBeFalse();
    expect(
      decide(facts({ doctor: "Claude Code doctor\nNo installation issues found." })).allow,
    ).toBeFalse();
  });

  test("refuses when the signed-in account cannot be read", () => {
    expect(decide(facts({ auth: null })).allow).toBeFalse();
  });

  test("refuses an unrecognised plan or a bare token on the Anthropic API", () => {
    expect(
      decide(
        facts({ auth: { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" } }),
      ).allow,
    ).toBeFalse();
    expect(
      decide(
        facts({
          auth: {
            loggedIn: true,
            authMethod: "claude.ai",
            apiProvider: "firstParty",
            subscriptionType: "business",
          },
        }),
      ).allow,
    ).toBeFalse();
  });

  test("allows a session routed to a gateway that is not Anthropic's API", () => {
    const v = decide(
      facts({
        baseUrl: "https://api.llmgateway.io",
        auth: { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      }),
    );
    expect(v).toEqual({
      allow: true,
      why: "prompts go to api.llmgateway.io, not to an Anthropic organisation",
    });
  });

  test("still checks the login when the base URL is Anthropic's own API", () => {
    const v = decide(
      facts({
        baseUrl: "https://api.anthropic.com",
        auth: {
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "enterprise",
        },
      }),
    );
    expect(v.allow).toBeFalse();
  });

  test("allows a third-party cloud provider", () => {
    expect(decide(facts({ auth: { loggedIn: true, apiProvider: "bedrock" } })).allow).toBeTrue();
  });

  test("refuses every account, personal too, when an admin policy sits on the machine", () => {
    const v = decide(
      facts({
        endpointPolicies: ["/Library/Application Support/ClaudeCode/managed-settings.json"],
      }),
    );
    expect(v.allow).toBeFalse();
    expect(v.why).toContain("managed-settings.json");
  });
});

describe("settingsFetchPending", () => {
  // Measured 2026-10-28 on a Team login: doctor prints this while its own refresh of the settings cache runs.
  const PENDING = "Managed settings (remote): checking… (fetch in progress; re-run in a moment)";

  test("names doctor's in-flight settings fetch, which a re-run a moment later resolves", () => {
    expect(
      settingsFetchPending(
        `Claude Code doctor\n${PENDING}\nOrganization policy: Loaded from api.anthropic.com`,
      ),
    ).toBeTrue();
  });

  test("is false for a settled answer or no doctor output", () => {
    for (const doctor of [TEAM_NONE, PERSONAL_LINE, null])
      expect(settingsFetchPending(doctor)).toBeFalse();
  });

  // Doctor writes the cache with its own fetch after it prints (measured 2026-10-28: six runs in a row printed
  // "checking", each leaving remote-settings.json synced at its own run time).
  const team = (freshRemoteSettings: unknown) => ({
    ...work("team", PENDING),
    freshRemoteSettings,
  });

  test("allows a Team login when doctor is mid-fetch and the cache that fetch wrote holds nothing", () => {
    expect(decide(team({}))).toEqual({
      allow: true,
      why: "Acme is a Team login with no managed settings pushed",
    });
  });

  test("refuses a Team login mid-fetch when the fresh cache holds settings, or no fresh cache was written", () => {
    for (const cache of [{ env: { OTEL_LOG_USER_PROMPTS: "1" } }, null, undefined, [], "{}"]) {
      expect(decide(team(cache)).allow).toBeFalse();
    }
  });

  test("never lets a fresh empty cache stand in for a settled answer that names settings", () => {
    expect(
      decide({
        ...work("team", "Managed settings (remote): 2 settings loaded"),
        freshRemoteSettings: {},
      }).allow,
    ).toBeFalse();
  });
});

describe("freshRemoteSettings", () => {
  // What Claude Code writes: a ms-epoch synced-at file and a 2-byte cache (measured 2026-10-28).
  const since = 1793200943786;

  test("parses a cache synced at or after the check began", () => {
    expect(freshRemoteSettings(String(since), since, "{}")).toEqual({});
    expect(
      freshRemoteSettings(`${since + 1500}\n`, since, '{"env":{"OTEL_LOG_USER_PROMPTS":"1"}}'),
    ).toEqual({ env: { OTEL_LOG_USER_PROMPTS: "1" } });
  });

  test("is null for a cache synced before the check, so an old empty cache never admits a login", () => {
    expect(freshRemoteSettings(String(since - 1), since, "{}")).toBeNull();
  });

  test("is null when synced-at is missing, empty or not a number, or the cache is missing or not JSON", () => {
    for (const syncedAt of [null, "", " ", "NaN", "soon"])
      expect(freshRemoteSettings(syncedAt, since, "{}")).toBeNull();
    expect(freshRemoteSettings(String(since), since, null)).toBeNull();
    expect(freshRemoteSettings(String(since), since, "{")).toBeNull();
  });
});

describe("loginIdentity", () => {
  test("names the organisation and email .claude.json is signed in with", () => {
    const json = JSON.stringify({
      oauthAccount: { organizationUuid: "org-1", emailAddress: "me@example.com" },
      projects: {},
    });
    expect(loginIdentity(json)).toBe("org-1|me@example.com");
  });

  test("tells two logins apart and names nobody when there is no account or the file is mid-write", () => {
    const a = loginIdentity(
      JSON.stringify({
        oauthAccount: { organizationUuid: "org-1", emailAddress: "me@example.com" },
      }),
    );
    const b = loginIdentity(
      JSON.stringify({
        oauthAccount: { organizationUuid: "org-2", emailAddress: "me@work.example" },
      }),
    );
    expect(a).not.toBe(b);
    expect(loginIdentity("{}")).toBeNull();
    expect(loginIdentity('{"oauthAccount": {')).toBeNull();
  });
});

describe("claudeLineage", () => {
  const providers = {
    claude: { env: { A: "base", B: "base" } },
    "claude-devpass": {
      extends: "claude",
      env: { B: "devpass", ANTHROPIC_BASE_URL: "https://api.llmgateway.io" },
    },
    "claude-work": { extends: "claude-devpass" },
    loop: { extends: "loop" },
    opencode: { env: { X: "1" } },
  };

  test("the built-in claude provider is Claude, with its configured env", () => {
    expect(claudeLineage(providers, "claude")).toEqual({
      isClaude: true,
      env: { A: "base", B: "base" },
    });
  });

  test("a provider extending claude is Claude, and its own env wins over the base's", () => {
    expect(claudeLineage(providers, "claude-work")).toEqual({
      isClaude: true,
      env: { A: "base", B: "devpass", ANTHROPIC_BASE_URL: "https://api.llmgateway.io" },
    });
  });

  test("an unconfigured built-in claude is still Claude", () => {
    expect(claudeLineage({}, "claude").isClaude).toBeTrue();
  });

  test("other built-in providers are not Claude", () => {
    expect(claudeLineage(providers, "opencode").isClaude).toBeFalse();
    expect(claudeLineage(providers, "codex").isClaude).toBeFalse();
  });

  test("a cycle is treated as Claude, so it is checked rather than skipped", () => {
    expect(claudeLineage(providers, "loop").isClaude).toBeTrue();
  });
});
