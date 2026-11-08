import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";

// Paseo bundles shared/ for the client as well and refuses a Node module there ("Node module cannot be imported into
// the plugin shared bundle"). A plugin whose shared code imports one fails every update and keeps its last good build.

/** Bundles `entrypoints` for the browser and returns every Node built-in the module graph reaches. */
async function nodeBuiltinsReachedBy(entrypoints: string[]): Promise<string[]> {
  const reached: string[] = [];
  const result = await Bun.build({
    entrypoints,
    target: "browser",
    throw: false,
    plugins: [
      {
        name: "record-node-builtins",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return undefined;
            reached.push(`${args.path} from ${path.basename(args.importer)}`);
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "the shared bundle did not build");
  return reached.sort();
}

const sharedDir = path.join(import.meta.dir, "shared");
const sharedEntries = readdirSync(sharedDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => path.join(sharedDir, name));

test("shared/ bundles for the browser without reaching a Node built-in", async () => {
  expect(sharedEntries.length).toBeGreaterThan(0);
  expect(await nodeBuiltinsReachedBy(sharedEntries)).toEqual([]);
});

test("the bundle check catches Node built-ins, side-effect and bare-name imports included", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-scope-shared-"));
  const file = path.join(dir, "uses-node.ts");
  writeFileSync(
    file,
    'import "node:path";\nimport { readFileSync } from "fs";\nexport const read = readFileSync;\n',
  );
  expect(await nodeBuiltinsReachedBy([file])).toEqual([
    "fs from uses-node.ts",
    "node:path from uses-node.ts",
  ]);
});
