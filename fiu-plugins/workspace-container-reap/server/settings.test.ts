import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_SETTINGS } from "../shared/reap.core";
import { readSettings, resolveFiuBin } from "./settings";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wcr-settings-"));
  roots.push(root);
  return root;
}

function write(contents: string): string {
  const file = path.join(temp(), "settings.json");
  fs.writeFileSync(file, contents);
  return file;
}

describe("readSettings", () => {
  test("an absent file is the normal case, not an error", () => {
    expect(readSettings(path.join(temp(), "missing.json"))).toEqual({
      settings: DEFAULT_SETTINGS,
      error: null,
    });
  });

  test("reads the switches an operator actually sets", () => {
    const read = readSettings(
      write(JSON.stringify({ enabled: false, dryRun: true, settleMs: 5000 })),
    );
    expect(read.error).toBeNull();
    expect(read.settings.enabled).toBe(false);
    expect(read.settings.dryRun).toBe(true);
    expect(read.settings.settleMs).toBe(5000);
    expect(read.settings.timeoutMs).toBe(DEFAULT_SETTINGS.timeoutMs);
  });

  test("a malformed file keeps the DEFAULTS and reports why", () => {
    // Never a half-applied merge: a typo must not silently leave the reaper running with one
    // setting from the file and the rest invented.
    const read = readSettings(write("{not json"));
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.error).toContain("unreadable");
  });

  test("a JSON array is refused rather than read as an object", () => {
    const read = readSettings(write("[]"));
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.error).toBe("expected a JSON object");
  });

  test("a wrong-typed value rejects the whole file rather than poisoning the run", () => {
    const read = readSettings(
      write(JSON.stringify({ enabled: "yes", settleMs: -1, timeoutMs: "soon" })),
    );
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.error).toContain("invalid field(s)");
  });

  test("a partially-invalid file never half-applies: dryRun cannot stick while enabled silently stays true", () => {
    const read = readSettings(write(JSON.stringify({ enabled: "false", dryRun: true })));
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.error).not.toBeNull();
    expect(read.error).toContain("enabled");
  });

  test("an absent field is not invalid: omitting a key still means its default, with error null", () => {
    const read = readSettings(write(JSON.stringify({ dryRun: true })));
    expect(read.error).toBeNull();
    expect(read.settings.dryRun).toBe(true);
    expect(read.settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
  });

  test("fiuBin: null is the documented default and validates", () => {
    const read = readSettings(write(JSON.stringify({ fiuBin: null })));
    expect(read.error).toBeNull();
    expect(read.settings.fiuBin).toBeNull();
  });

  test("fiuBin: a blank string is invalid, not silently normalized to null", () => {
    const read = readSettings(write(JSON.stringify({ fiuBin: "   " })));
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.error).toContain("fiuBin");
  });

  test("fiuBin: a non-blank configured path is kept verbatim (trimmed)", () => {
    const read = readSettings(write(JSON.stringify({ fiuBin: " /opt/fiu " })));
    expect(read.error).toBeNull();
    expect(read.settings.fiuBin).toBe("/opt/fiu");
  });
});

describe("resolveFiuBin", () => {
  test("prefers the known install path over bare PATH lookup", () => {
    // The daemon is not a login shell, so ~/.local/bin is often absent from its PATH. Resolving the
    // real path is what stops the hook from failing as a bare ENOENT where fiu is plainly installed.
    const home = temp();
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "fiu"), "#!/bin/sh\n");
    expect(resolveFiuBin(DEFAULT_SETTINGS, home)).toBe(path.join(bin, "fiu"));
  });

  test("falls back to PATH when fiu is installed somewhere else", () => {
    expect(resolveFiuBin(DEFAULT_SETTINGS, temp())).toBe("fiu");
  });

  test("a configured path that does not exist THROWS rather than running something else", () => {
    const settings = { ...DEFAULT_SETTINGS, fiuBin: "/nope/fiu" };
    expect(() => resolveFiuBin(settings, temp())).toThrow(/does not exist/);
  });

  test("a configured path that exists is used verbatim", () => {
    const home = temp();
    const custom = path.join(home, "my-fiu");
    fs.writeFileSync(custom, "#!/bin/sh\n");
    expect(resolveFiuBin({ ...DEFAULT_SETTINGS, fiuBin: custom }, home)).toBe(custom);
  });
});
