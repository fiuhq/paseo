# jev-title-gate

A new workspace gets its title only after [Jev](https://api.typesafe.ai) calls it meaningful.

Paseo names a workspace with one background call, from the first prompt alone. A link reads
as nothing, so the model guesses, and the guess also names the branch. With this plugin
installed, the sidebar row and header read `Naming…` until a title scores 0.70 or higher. A
refused guess is dropped and the next one is written from the agent's reply, when the agent
has read the link. The branch rename waits for the same pass.

The plugin is one handler on Paseo's `workspace.title.before` hook. Registering it is what
turns the hold on; removing it puts naming back to how it was. Paseo owns the tries (three),
the states and the UI.

## What happens when

| Situation                        | What you see                                                     |
| -------------------------------- | ---------------------------------------------------------------- |
| The prompt is specific, no link  | The title goes on at once.                                       |
| It holds a link, or a poor guess | `Naming…`, and why, until the agent replies.                     |
| Three tries refused              | The best-scored try goes on, with its score and a Rename button. |
| Three tries refused, none scored | `Naming…` with a Rename button.                                  |
| The agent never replies          | `Naming…` with a Rename button.                                  |
| Jev is unreachable               | The title goes on, marked `Not checked`.                         |
| You or an agent rename it        | Your name wins and the hold ends.                                |

## What leaves the machine

Only the candidate title, with any full URL or mail address removed, and one phrase saying whether
it came from the user or the agent. The prompt and the agent's reply stay here: the plugin
refuses a first guess locally when the prompt holds a link, and Jev does not need the rest. A title can
still name a project or a customer, because that is what a good title does.

## Install

```sh
paseo plugin add git:fiuhq/paseo:fiu-plugins/jev-title-gate
```

The fleet declares it in fiu-cli's plugin list (`packages/fiu-cli/sync/paseo-plugins.ts` in fiuhq/core). It needs a daemon that has
the `workspace.title.before` hook, and `fiu` at `~/.local/bin/fiu`.

Logs: `paseo plugin logs jev-title-gate`.
