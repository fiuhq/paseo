# Daily quotes

Our own quote of the day as the New workspace headline: a small "NEW WORKSPACE · TODAY" eyebrow
above today's quote. With no quotes, or with the switch off, the screen keeps its "New workspace"
title.

- **Settings › Plugins › Daily quotes** (the plugin row's cog) turns it on or off and lists the
  quotes in the order they come up, starting with today's. ✕ removes one; the row stays as
  "Removed" with **Undo** until you add a quote or leave the screen.
- **`/quote <text>`** in any workspace composer adds a quote at the end of the rotation.

The daemon keeps one list per host in `$PASEO_HOME/daily-quotes/quotes.json`, written with a
temporary file and a rename, so every client of that host sees the same list. Each client computes
today from its own clock: today's quote is `quotes[(day - anchorDay) mod n]`, and every change
re-anchors on the day it is made, so removing today's quote hands today to the next one. A new host
starts with the quotes and terms in `shared/quotes.ts`. A file that does not parse is reported, never
overwritten.

The title needs a Paseo build with `client.addNewWorkspaceTitle`; on an older build the plugin
fails to load with a message naming `client.addNewWorkspaceTitle`. `bun run verify` typechecks and
runs the tests.
