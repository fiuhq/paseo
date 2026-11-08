# workspace-gate-enrol

A Paseo worktree is **born with a no-mistakes gate of its own**, so its first push
cannot land on the main checkout's.

## The problem

A gate is keyed on the checkout **path**: `no-mistakes init` creates
`<NM_HOME>/repos/<sha256(path)[:12]>.git` and records that path in its database.

A worktree that was never initialised has no such mirror, so `git push no-mistakes`
falls through to the container's **shared** `remote.no-mistakes.url` and starts a run
on whatever that names — in practice the main checkout's gate. That run cannot be
driven from the worktree it came from: `no-mistakes axi run` resolves by exact path,
finds no repo, and refuses. The stray run then has to be aborted by id.

Measured 2026-09-18 on fiuhq/core — 9 of 16 worktrees were in this state, 5 of them
with main's gate (`464fbd9ad153.git`) written into their own `config.worktree`:

|                                       |       |
| ------------------------------------- | ----- |
| wired to their own gate               | 6     |
| no wiring at all                      | 4     |
| **wired to the main checkout's gate** | **5** |

## What this does

| Hook                | Action                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `workspace.created` | plan from git facts, then `no-mistakes init` and record a per-worktree `remote.no-mistakes.pushurl` |

The plan is pure and unit-tested (`shared/enrol.core.ts`):

- own gate exists and is wired → **ok**, nothing is spent
- own gate exists, pushurl names another checkout's → **rewire** (no init)
- no gate → **enrol** (`no-mistakes init`, then record the pushurl)
- not a checkout / no `origin` / no `extensions.worktreeConfig` → **skip**, with the reason

## Why here and not in fiu's reconciler

`reconcileWorktreeGateRemotes` deliberately refuses to enrol — it only records a
pushurl for a gate that already exists, because enrolment costs a mirror on disk and a
sync should not spend that on every historical worktree it walks (this node carries
dozens that will never push again). Creation is where that cost is expected and
proportionate: one gate per workspace actually created.

## Safety rules

- a checkout that already has its own gate is never re-initialised;
- where the container has a shared url, `no-mistakes init` runs with that `nm://` name
  mapped onto this gate for init alone (a scratch global config that rewrites it first and
  then includes the real global files, XDG and `~/.gitconfig`, so credential helpers
  stay), after the worktree's push url is set to the gate and the daemon is started from
  the plain environment if it was down: since v1.104 init refuses a shared url it cannot
  resolve to this checkout's gate. An older init rewrote the **container's** shared url,
  so the previous value is still captured and put back if it moved;
- the gate is recorded with `git config --worktree`, never the shared config;
- the mirror is verified to **exist** after init rather than trusting the exit code;
- every failure logs and returns, and a failed init puts the worktree's own push url back
  as it was. Workspace creation must never become a hard failure — the worst case is the
  pre-push gate blocking the first push with the exact repair.

## Deliberately not here

Reaping a gate when a workspace is archived. Paseo exposes only `workspace.archived`
(after the fact, when the directory may already be gone), and a gate mirror can hold
the only copy of a parked run's branch — deleting one automatically could destroy work.

## Verify

    bun run verify        # tsc --noEmit && bun test

Logs: `paseo plugin logs workspace-gate-enrol`.
