/**
 * The one thing a directory install cannot catch.
 *
 * When the daemon installs this plugin from Git it clones the repository, builds the bundle
 * out of the bare checkout, and nothing is ever installed into it. Only the specifiers the
 * host supplies stay external; anything else has to resolve on disk, and a type-only import
 * that cannot resolve fails the install with `Could not resolve type dependency "<name>"`
 * before the plugin is ever configured. A directory install off a developer's tree resolves
 * the same import happily, so the mistake is invisible until the fleet tries to install it.
 *
 * This test is that check, kept next to the code it constrains: it copies the package into a
 * directory with no node_modules and resolves every module the way a bare checkout would.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "@typescript/typescript6";

const PACKAGE_ROOT = import.meta.dir;

/** Supplied by the host and left external — daemon 0.8.0, `plugin-sdk-specifiers.js`. */
const HOST_SDK = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/acp",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
];

/** Also bundled by the host, from the same build's boundary plugin. */
const HOST_PACKAGES = /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...sourceFiles(full));
      continue;
    }
    // Tests are never bundled: the daemon builds from the two entry points.
    if (
      /\.[cm]?tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    )
      files.push(full);
  }
  return files;
}

/** Every module a bare checkout cannot resolve, minus what the host supplies. */
function unresolvedInBareCheckout(extra: Record<string, string> = {}): string[] {
  const root = mkdtempSync(path.join(tmpdir(), "jev-auto-compact-bare-"));
  for (const file of sourceFiles(PACKAGE_ROOT)) {
    const target = path.join(root, path.relative(PACKAGE_ROOT, file));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(file, target);
  }
  for (const [name, content] of Object.entries(extra))
    writeFileSync(path.join(root, name), content);
  const program = ts.createProgram(sourceFiles(root), {
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    types: [],
  });
  const missing = new Set<string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.code !== 2307) continue;
    const name = /Cannot find module '([^']+)'/.exec(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )?.[1];
    if (name && !isBuiltin(name) && !HOST_SDK.includes(name) && !HOST_PACKAGES.test(name))
      missing.add(name);
  }
  return [...missing].sort();
}

describe("what the bundle may import", () => {
  it("resolves every module in a checkout with nothing installed", () => {
    expect(unresolvedInBareCheckout()).toEqual([]);
  });

  it("rejects the daemon API type imported from a package the host does not supply", () => {
    const missing = unresolvedInBareCheckout({
      "regression.ts":
        'import type { PaseoApi } from "@getpaseo/client";\nexport type Use = PaseoApi;\n',
    });
    expect(missing).toEqual(["@getpaseo/client"]);
  });
});
