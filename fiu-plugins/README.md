# fiu plugins

The Paseo plugins every fiu node runs, kept beside the Paseo source they are built against. Each
directory is one standalone plugin: its own `paseo-plugin.json`, `package.json`, lockfile and tests.
Nodes install them from this repository as Git plugins (`https://github.com/fiuhq/paseo.git:fiu-plugins/<id>`),
declared once in fiu-cli's plugin list.

Every manifest sets `"checkout": "directory"`. A daemon built with that field ([fiuhq/paseo#57](https://github.com/fiuhq/paseo/pull/57))
then checks out only the plugin's directory; an older daemon ignores the key and checks out the
whole repository. Either way a plugin imports nothing from outside its own directory; tests may.

Check a plugin with `bun install --frozen-lockfile && bun run verify` in its directory. The
`fiu plugins` workflow runs that for every plugin on each change here.
