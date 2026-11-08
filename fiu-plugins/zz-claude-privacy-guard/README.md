# zz-claude-privacy-guard

A Paseo Claude agent never sends a prompt through a work organisation that can read it. Only a personal
login, a non-Anthropic gateway, or a Team login whose organisation pushes no managed settings may carry one.

**Why the `zz-` prefix.** Paseo runs plugins' `agent.session_open` hooks one after another, sorted by plugin
id, and each sees the environment the ones before it produced. An account switcher (ZeroSub, for one) sets
`CLAUDE_CONFIG_DIR` in that hook to pick the login a session runs on. The guard must judge the login the
session will really use, so its id sorts after every other plugin's. A test in fiu-cli holds it there.

## The problem

A Claude Team or Enterprise organisation can read its members' Claude Code prompts:

- **Pushed settings.** Owners push [server-managed settings](https://code.claude.com/docs/en/server-managed-settings)
  that turn on OpenTelemetry prompt logging (`OTEL_LOG_USER_PROMPTS` and friends), add hooks that receive
  every prompt and the transcript path, or route traffic through a proxy.
- **The Compliance API (Enterprise).** It returns the transcripts of local Claude Code sessions, prompts
  included. They are [captured as requests reach the API](https://platform.claude.com/docs/en/manage-claude/compliance-faq),
  so nothing on the machine changes when it is switched on.

A terminal session shows an approval dialog before pushed hooks or env apply. An Agent SDK session,
which is every Paseo agent, [applies them for the run without asking](https://code.claude.com/docs/en/managed-settings).
A Claude Code hook cannot be the guard either: pushed settings can turn user hooks off
(`allowManagedHooksOnly`), and Claude Code strips `OTEL_*` from the env a hook sees.

## What this does

The check runs in the Paseo daemon, outside Claude Code, so no pushed setting reaches it.

| Layer          | Hook                                              | Effect                                                                                                                                                                                           |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. refuse      | `agent.session_open` (before)                     | the open throws, so the session never starts                                                                                                                                                     |
| 2. login watch | `.claude.json` names a different account          | a running Claude Code process picks up a new login within about 30 seconds (`claude /login`, an account switcher), so every live Claude agent is re-checked at once and refused ones are stopped |
| 3. re-check    | `agent.turn_ended`, `agent.turn_started` (events) | settings refresh hourly in a running session; a session that now fails is stopped before its next prompt, and every later turn of a stopped agent is stopped as it starts                        |

**Stopped, never archived.** Only the operator archives. To stop an agent the guard ends its session's Claude
process: the turn fails with "Claude stopped unexpectedly", the way a usage limit stops one, and the agent
stays in the sidebar with its status. Paseo's plugin API offers no cancel or close, and a later prompt starts a
fresh process without reopening the session, so the guard stops each new turn of a refused agent as it starts.

The verdict, from `claude auth status`, `claude doctor` and the machine's policy files:

| Session                                                                                                                                                                                                  | Verdict                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| an admin policy file or MDM profile on the machine                                                                                                                                                       | refused, whatever the account                                                                        |
| `ANTHROPIC_BASE_URL` pointing somewhere other than `api.anthropic.com`                                                                                                                                   | allowed: no Anthropic organisation is involved                                                       |
| personal Free, Pro or Max login, and `claude doctor` reads the live credential as personal too                                                                                                           | allowed                                                                                              |
| Team login while `claude doctor` reads `Managed settings (remote): none configured for this organization`, or doctor is still fetching and the settings cache it wrote during this check is empty (`{}`) | allowed: Team has no Compliance API, so pushed settings are its only way to prompts                  |
| Team login with anything pushed, or when doctor cannot say                                                                                                                                               | refused                                                                                              |
| Enterprise, or a plan it cannot name                                                                                                                                                                     | refused, even with nothing pushed: the Compliance API reads transcripts with no trace on the machine |
| a personal account record whose live credential `claude doctor` reads as an organisation's                                                                                                               | refused                                                                                              |
| anything it cannot read                                                                                                                                                                                  | refused                                                                                              |

`claude auth status` takes the plan from the stored credential and the organisation name from the account
record in `.claude.json`; `claude doctor` reads the live credential. An account switcher can rewrite one
without the other (measured 2026-10-22: the record named a Team login while the credential was a personal
one), so a personal plan must also read personal in doctor, and a Team plan must read nothing pushed. The
plan itself is the credential's: on 2026-10-28 one config directory read `max` or `team` depending only on
which credential store it was handed, so a switched-in Enterprise credential reads `enterprise`.

Only providers that are Paseo's `claude` or `extends` it are checked. Codex, OpenCode and the rest are not.

To use a work login without Paseo, keep it out of the global login: run it in its own terminal with its
own configuration directory instead of `claude /login`.

## Limits

- It cannot see what Anthropic stores for the organisation outside Claude Code. claude.ai chats are in
  the Primary Owner's organisation export whatever this guard does.
- A prompt already sent when the hourly refresh lands is not recalled; layer 3 stops the next one. On an
  allowed Team login, one turn can go out after an owner switches prompt logging on and before the guard
  sees it.
- Paseo has no plugin hook at prompt admission, so stopping is best-effort, not fail-closed. The operator
  chose that on 2026-10-28, told that a refused login lets one turn go out before the guard notices: "that's
  fine but don't ever auto archive, just stop it". A prompt sent in the second or so between a
  turn ending and the re-check finishing can go out. So can a later prompt to a stopped agent: Paseo hands it
  to the fresh Claude process before `agent.turn_started` fires, and the guard's stop (a `ps` scan, then a
  signal, before any re-check) only wins while that process is still starting up.
- The guard remembers which agents it stopped only while the daemon runs; after a restart a stopped agent's
  session reopens through layer 1, which refuses it again.
- While a session would be refused, so is reading an archived Claude agent's transcript. Paseo loads an
  archived agent the same way (`purpose: "history"`) whether it shows the log or sends it a new prompt, so
  exempting history would let that prompt through.
- On WSL the Windows policy locations are checked too: `C:\Program Files\ClaudeCode` files and the
  `HKLM\SOFTWARE\Policies\ClaudeCode` key.
- A running agent's requests between the login changing and the watch stopping it (the time to run
  `claude auth status` and `claude doctor`, about a second) still go out under the new login.
- The watch needs the Paseo API, which a plugin only receives inside a hook; until the first agent event
  after the plugin loads, a login change is logged but running agents are not re-checked. If the directory
  holding `.claude.json` cannot be watched, or the watch fails later, that is logged and layers 1 and 3
  still apply.
- Each `claude doctor` run starts its own fetch of the organisation's settings and usually prints
  `checking… (fetch in progress)` before it returns; the fetch then writes `remote-settings.json` in the login's
  config directory. For a Team login the guard reads that cache only when it was synced during this check, and
  allows only an empty one. No fresh cache is a refusal.
- It reads `claude doctor`'s `Managed settings (remote):` line. If Claude Code rewords the personal-login
  line, every Anthropic login is refused until the pattern is updated.

Logs: `paseo plugin logs zz-claude-privacy-guard`.
