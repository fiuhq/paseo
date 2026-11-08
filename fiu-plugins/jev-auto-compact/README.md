# jev-auto-compact

Compacts an agent when its work is **finished**, so the summary is written at a seam
instead of wherever the context window happened to run out mid-task.

Every ended turn is described abstractly and [Jev](https://api.typesafe.ai) answers two
questions about it in one call — is this a finished unit of work, and was it hands-on.
A turn earns `/compact` only when the combined score clears the floor, the context is
genuinely large, and the agent is sitting idle. No timers, no polling, no agents created:
one event, one judgment, one message.

## Install

```sh
paseo plugin add fiuhq/paseo:fiu-plugins/jev-auto-compact            # tracks the default branch
paseo plugin add fiuhq/paseo:fiu-plugins/jev-auto-compact --ref main
paseo plugin update jev-auto-compact                                           # pull a newer commit
```

The runtime id is **`jev-auto-compact`** — what `paseo plugin ls|logs|reload` take, and the
directory its state lives in (`~/.paseo/jev-auto-compact/`). Plugins must be enabled once per
daemon (`pluginsEnabled: true` in `~/.paseo/config.json`, or Settings → Plugins).

For a local edit loop, install the directory instead and reload after each change:

```sh
paseo plugin install /absolute/path/to/fiu-plugins/jev-auto-compact
paseo plugin reload jev-auto-compact
```

A Git install is built from a bare checkout: the daemon clones, bundles, and installs
nothing into it. So the code may name only the packages the host supplies — `@getpaseo/plugin*`,
`zod`, `react`, `react-native`, `@tanstack/react-query` and Node builtins — and any other
import, **including a type-only one**, fails the install with `Could not resolve type
dependency`. A directory install resolves those happily, which is why `bundle-imports.test.ts`
checks it here instead.

## How a turn is decided

1. **`agent.turn_ended`** arrives with the agent, the outcome and the timeline.
2. **Cheap gates** — the turn completed, the provider has a known compaction command, the
   agent is idle with no pending permission and no call from _this_ exchange still running,
   the last timeline entry is not itself a compaction, the context is above `minTokens`
   _and_ above `minUsedRatio` of the window. Anything else stops here, before any cost.
   Only the exchange that just ended can still be in flight: a call left running in an
   earlier one is a stranded entry, and since nothing ages an entry out of an append-only
   stream, honouring it would refuse that agent every turn from then on. It is counted
   separately and told to the judge rather than acted on.
3. **Claim** — `agents/<id>/claims/<sha>.json` is created with `open(…, "wx")`. The
   filesystem grants it to exactly one caller, so a replayed event, a plugin reload, a
   daemon restart or a second daemon cannot produce a second `/compact`.
4. **Judge** — one `fiu jev ask` with a bounded (~2 kB) redacted description of the turn.
5. **Score** — `P(finished) × (0.5 + 0.5 × P(hands-on))` against `floor`.
6. **Deliver** — the agent's facts are read once more (the person may have typed while the
   judge thought), then `/compact` is sent as a message.

Outcomes are `skipped`, `duplicate`, `held`, `dry-run`, `compacted` and `failed`; each is
appended to `agents/<id>/log.jsonl`.

## What leaves the machine

Only the description in step 4, and only after redaction: urls, emails, git remotes,
absolute paths, hosts, IP addresses, uuids and long opaque tokens become `<url>`,
`<path>`, `<host>`, `<id>` and so on, plus any literal in `policy.redactWords`. It carries
message counts, tool names, the person's latest message and the assistant's latest answer,
each clipped, and the whole description is bounded to 2 kB of UTF-8 — bytes, not characters,
so a conversation in a multi-byte script is bounded by the same promise. Redaction is best-effort: a session holding material that must not leave the
host belongs in `enabled: false` or outside `agents`, not in a better regex.

## Settings

`~/.paseo/jev-auto-compact/settings.json`, re-read whenever it changes — no reload needed. A
file that does not parse — or one the plugin cannot reach at all, which is not the same as
one that is not there — **disables** the plugin and logs why; it never silently reverts to
the defaults.

A node still holding `~/.paseo/fiu-compact/settings.json` from before the rename has that
file copied here once, on first read, so an existing `enabled: false`, agent allowlist or
`redactWords` survives it. The same applies to the record of what was already compacted:
an agent's folder under `~/.paseo/fiu-compact/agents/` is copied across the first time that
agent is judged here, so a turn compacted under the old id is not compacted again under
this one. Neither copy overwrites anything already written under the current name.

```jsonc
{
  "enabled": true,
  "debug": false, // also log skips, the timeline shape and the judged state
  "agents": [], // empty = every agent; a list scopes the rollout
  "jevBin": "/home/you/.local/bin/fiu", // absolute: no shell expands a ~
  "jevTimeoutMs": 45000,
  "policy": {
    "floor": 0.85,
    "minTokens": 120000,
    "minUsedRatio": 0.6, // …and at least this share of the window
    "redactWords": [], // project, tenant and org names a regex cannot know
    "dryRun": false, // judge and record, deliver nothing
  },
}
```

Which providers can be compacted is **not** settable: the table lives in
`server/slash-channel.ts` and holds `claude` alone, because only its `/compact` has been
measured end to end. A derived harness (`claude-work`) inherits its base's command; any
other provider is skipped by name until its own command is verified the same way.

## Why the numbers are what they are

Measured against jev-1.13.0 on 2026-09-21:

| turn                               | P(finished) | P(hands-on) | score |
| ---------------------------------- | ----------- | ----------- | ----- |
| mid-task, announced a next step    | 0.02        | 0.44        | 0.01  |
| finished discussion, nothing built | 0.90        | 0.10        | 0.50  |
| finished, code written and green   | 0.94        | 0.91        | 0.90  |

The judge's own certainty tops out near 0.94 per question, so a floor above ~0.92 can
never fire. `0.85` admits the third row and nothing else.

## Why `/compact` is sent as a message

Paseo cannot compact a session on an agent's behalf. A Claude session started by the
daemon is headless, where the harness's own compaction entry point refuses — measured on
2026-09-21 against Claude Code 2.1.278: _"compaction here runs inside a turn"_. Sending
`/compact` as a message does work, because the harness runs it in-session: a 27,123-token
session came back at 1,209.

## Verify

```sh
bun install
bun run verify          # tsc --noEmit && bun test
```

This package is deliberately not a root workspace member: it carries its own lockfile, so the
Paseo app's install and build never pay for its dependencies.

The pure core (`shared/`) runs with no daemon, no judge and no agent; the adapters
(`server/`) are covered against recorded real output and a real temporary directory.

End-to-end on 2026-09-21, against a live probe agent on the daemon: held at 0.10 and 0.35
while the answer was read wrong, 0.91 once it was read whole, one dry run, then
`compacted … at 36263 tokens — score 0.92 >= 0.85`, with the agent's own snapshot dropping
to 4,718 tokens. The turn that followed — the `/compact` turn itself — was skipped as
_just compacted_.
