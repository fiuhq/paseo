# workspace-base-guard

A Paseo worktree always starts from the **recent remote head**, never from a stale
local branch.

## The problem

Paseo resolves a bare branch name **local-first**: `refs/heads/<name>` is tried
before `refs/remotes/origin/<name>`. Its own docs say so:

> Use `origin/main` rather than `main`. … An unqualified `main` resolves to that
> local branch first, and the worktree starts from stale history.
> — https://paseo.sh/docs/worktrees

Measured against the live daemon on 2026-09-17: a request with
`baseBranch: "release/V3"` produced a worktree at the **local** tip
(`2c4b7af`) while `origin/release/V3` produced the fetched remote tip
(`ef48f968`) — 24 commits apart. A request with **no base at all** is the same
trap: `resolveDefaultBranch` prefers the local branch name whenever that branch
exists.

## What this does

Paseo has two worktree-creation code paths, so the guard has two layers.

| Layer                     | Hook                        | Covers                                                     |
| ------------------------- | --------------------------- | ---------------------------------------------------------- |
| 1. request rewrite        | `workspace.create` (before) | UI New-workspace dialog, `paseo workspace create`          |
| 2. post-create correction | `workspace.created` (event) | MCP `create_workspace`, the `create_agent` worktree target |

Layer 2 exists because those paths call `createPaseoWorktreeCommand` directly and
never pass through the message handler, so no before-hook runs for them — verified
on 2026-09-17 by observing no hook log and a stale base.

## Safety rules

The guard must never discard unpushed work, so it qualifies a base only when
origin is at least as new:

- `origin/release/V3` → untouched (already qualified)
- `release/V3` + local not ahead → `origin/release/V3`
- `release/V3` + local has unpushed commits → **kept**
- `wip/local-only` → **kept** (no origin counterpart)
- any git failure → request untouched, error logged

Layer 2 resets only a worktree it can prove is safe: Paseo-owned metadata, an
existing origin base, HEAD strictly behind it, and **no** local modifications.
A dirty or diverged worktree is reported and left alone.

A guard must never turn workspace creation into a hard failure, so every code path
catches, logs, and returns the original request.

## Verify

```bash
npx tsc --noEmit && bun test
paseo plugin logs workspace-base-guard
```
