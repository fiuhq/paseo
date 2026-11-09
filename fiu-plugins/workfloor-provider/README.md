# Workfloor provider

A Paseo provider whose agents are your private Workfloor conversations. Pick one of a project's
agents as the model (`Buildy · codev`); the first message starts a conversation with it in
Workfloor, and every later message goes to that conversation's agent. Paseo's session list shows
your conversations, so you can open one you started in Workfloor.

Connect it in Paseo's Settings, Workfloor: Workfloor's address and a personal token that can read
and write (Workfloor: Settings, Personal tokens). The token stays on this host, in the plugin's
settings.

It talks to Workfloor as you, through the routes Workfloor's own page uses
(`/api/conversations`, `/api/conversation`, `/api/events`, `/api/lane-flows/questions`); Workfloor
lets a token that writes reach them, audits each write as made by a token, and refuses it a go on a
gate or a permission. So:

- the agent's question is asked in Paseo, while the turn stays open: pick an option, write your own
  answer, or decline it; one you answer in Workfloor meanwhile is withdrawn here;
- a plan step's go, an approval, a handoff or issue the agent offers, and a permission request are
  answered in Workfloor: the turn ends with a link to the conversation;
- the agent works in Workfloor, on its project's repositories, not in your Paseo workspace;
- a conversation keeps the agent it started with.

Check it with `bun install --frozen-lockfile && bun run verify` here, after `npm ci` and building
`@getpaseo/client` and `@getpaseo/plugin` at the repository root.
