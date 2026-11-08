# workspace-agent-scope

Runs `fiu ws agent-scope` when Paseo creates or archives a workspace, so a new worktree's git registration
reaches each beta's agent-scope Mutagen session right away instead of on a timer. See fiu-cli
`sync/agent-scope-sync.ts` for what the scope carries.

- Bursts of events collapse into one follow-up run.
- An archive runs once its worktree's directory is gone, because Paseo can report it before the worktree is removed;
  a workspace whose directory stays changes no scope and runs nothing.
- On the controller it runs locally. On a beta (a workspace created or archived there during a failover) it runs the
  beta's own half, then asks the controller with `fiu --machine mac ws agent-scope`.
- An event that arrives during a failing run still gets its follow-up run. A failed run is logged
  (`paseo plugin logs workspace-agent-scope`) and not retried on a timer.
- A workspace created in a repo with an origin also fast-forwards the controller's checkouts of that repo
  (`fiu ws repos --of <origin>`), since that is the event that says the repo is being worked in.
