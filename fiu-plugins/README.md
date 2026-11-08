# fiu plugins

The Paseo plugins every fiu node runs, kept beside the Paseo source they are built against. Each
directory is one standalone plugin: its own `paseo-plugin.json`, `package.json`, lockfile and tests.
Nodes install them from this repository as Git plugins (`https://github.com/fiuhq/paseo.git:fiu-plugins/<id>`),
declared once in fiu-cli's plugin list.

Every manifest sets `"checkout": "directory"`, so an install checks out only that plugin's
directory. A plugin must therefore import nothing from outside its own directory; tests may.

Check a plugin with `bun install --frozen-lockfile && bun run verify` in its directory. The
`fiu plugins` workflow runs that for every plugin on each change here.
