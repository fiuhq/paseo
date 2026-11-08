# workspace-container-reap

Stops the containers a workspace started, when that workspace is closed.

A Compose stack outlives the worktree that defined it. Paseo archives the workspace and deletes the
directory; the containers keep running — polling, restarting, holding memory — with nothing left that
refers to them. On the Mac this was found as four `hatchet-engine` containers in crash-restart loops
from worktrees that no longer existed, alongside three abandoned stacks, on a host that had been
paging continuously for two days.

The reaping is `fiu docker reap`, unchanged. It already knows which projects a live Paseo agent
owns (the `one.fiu.owner` label) and which allowlisted containers are permanent. This plugin supplies the trigger it never
had: `workspace.archived`.

## Why it is safe to fire automatically

The hook runs `fiu docker reap --workspace <cwd> --apply`.

`--workspace` narrows the plan to the Compose projects whose config files live inside the workspace
that just closed, so closing one workspace can never stop a stack a sibling workspace is still using.
A bare container has no Compose config path and is therefore never in a scoped run — the unscoped
`fiu docker reap` remains the only thing that can reach one.

On top of that the reaper's own rules still apply: a project owned by a live Paseo agent is kept, and
`nordlayer-hop` is a permanent exception.

The hook waits `settleMs` before running. Paseo's hook contract says an archive event "can precede
runtime/worktree cleanup", and the owning agent is archived by that same
teardown — reaping instantly could read an owner that is still live and correctly stop nothing.

Reaps are serialized process-wide: closing several workspaces at once does not run concurrent
`docker compose down`s against the same engine.

## Settings

`~/.paseo/workspace-container-reap/settings.json`. An absent file means the defaults.

| Key         | Default  | Meaning                                                                     |
| ----------- | -------- | --------------------------------------------------------------------------- |
| `enabled`   | `true`   | Master switch. Off means the hook observes and does nothing.                |
| `dryRun`    | `false`  | Run the reaper without `--apply`, so the log shows what _would_ be stopped. |
| `settleMs`  | `20000`  | How long to let Paseo finish tearing the workspace down first.              |
| `timeoutMs` | `180000` | Hard cap on one reaper run, so a wedged Docker cannot pin the handler.      |
| `fiuBin`    | `null`   | Absolute path to `fiu`. `null` resolves `~/.local/bin/fiu`, then PATH.      |

A malformed file keeps the defaults and says so in the log rather than half-applying.

Watch it before letting it bite:

```json
{ "dryRun": true }
```

## Logs

```sh
paseo plugin logs workspace-container-reap
```

Every close writes one line: what was stopped, what was planned, that there was nothing to stop, or
that the reap failed. A failed reap is loud and is never retried on a timer — containers are still
running and that is a state to see, not to paper over.
