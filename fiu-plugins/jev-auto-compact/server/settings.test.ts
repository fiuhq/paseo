import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, parseSettings, SettingsFile } from "./settings";
import { DEFAULT_POLICY } from "../shared/compaction.core";

describe("parseSettings", () => {
  test("an empty file is the shipped policy", () => {
    const read = parseSettings({});
    expect(read.error).toBeNull();
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
  });

  test("overrides only what it names", () => {
    const read = parseSettings({ policy: { floor: 0.9, dryRun: true }, agents: ["agent-1"] });
    expect(read.settings?.policy).toEqual({ ...DEFAULT_POLICY, floor: 0.9, dryRun: true });
    expect(read.settings?.agents).toEqual(["agent-1"]);
  });

  test("a wrong type disables the plugin instead of quietly becoming the default", () => {
    const read = parseSettings({ enabled: "yes", policy: { floor: "high" } });
    expect(read.settings).toBeNull();
    expect(read.error).toContain("enabled must be true or false");
    expect(read.error).toContain("policy.floor must be a number");
  });

  test("a floor outside 0..1 is refused, not clamped", () => {
    expect(parseSettings({ policy: { floor: 1.5 } }).error).toBe(
      "policy.floor must be between 0 and 1",
    );
  });

  test("a policy that is not an object is refused, not defaulted", () => {
    for (const policy of [false, "dry", [1], null])
      expect(parseSettings({ policy }).error).toBe("policy must be an object");
  });

  test("a file that is not an object at all is refused", () => {
    expect(parseSettings([1, 2, 3]).error).toBe("settings must be a JSON object");
  });
});

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
};

describe("SettingsFile", () => {
  test("no file at all, and no legacy file either, is the shipped policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-settings-"));
    const read = await new SettingsFile(
      path.join(dir, "settings.json"),
      path.join(dir, "legacy.json"),
    ).read();
    expect(read.error).toBeNull();
    expect(read.settings).toEqual(DEFAULT_SETTINGS);
  });

  test("the pre-rename file is COPIED to the current name, so the policy survives the rename exactly once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-settings-"));
    const currentFile = path.join(dir, "home", "settings.json");
    const legacyFile = path.join(dir, "legacy.json");
    await fs.writeFile(legacyFile, JSON.stringify({ enabled: false, agents: ["agent-1"] }));
    const file = new SettingsFile(currentFile, legacyFile);

    const read = await file.read();
    expect(read.error).toBeNull();
    expect(read.settings?.enabled).toBeFalse();
    expect(read.settings?.agents).toEqual(["agent-1"]);
    // Copied, not moved: a still-running pre-rename instance keeps reading its own file until it is
    // actually retired, so the source is left in place rather than deleted out from under it.
    expect(await exists(legacyFile)).toBeTrue();
    expect(JSON.parse(await fs.readFile(currentFile, "utf8"))).toEqual({
      enabled: false,
      agents: ["agent-1"],
    });

    // And from here the current name is the only one read: an edit there wins, with no second path
    // to be shadowed by.
    await fs.writeFile(
      currentFile,
      JSON.stringify({ enabled: false, agents: ["agent-1", "agent-2"] }),
    );
    expect((await file.read()).settings?.agents).toEqual(["agent-1", "agent-2"]);
  });

  test("a current file is never clobbered by a pre-rename one left behind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-settings-"));
    const currentFile = path.join(dir, "settings.json");
    const legacyFile = path.join(dir, "legacy.json");
    await fs.writeFile(currentFile, JSON.stringify({ agents: ["current"] }));
    await fs.writeFile(legacyFile, JSON.stringify({ agents: ["stale"] }));

    const read = await new SettingsFile(currentFile, legacyFile).read();
    expect(read.settings?.agents).toEqual(["current"]);
    expect(await exists(legacyFile)).toBeTrue();
  });

  test("a pre-rename file that cannot be moved disables the plugin instead of silently defaulting", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-settings-"));
    // A regular file where the old plugin's directory belongs: the real ENOTDIR shape.
    const blocker = path.join(dir, "fiu-compact");
    await fs.writeFile(blocker, "not a directory");
    const file = new SettingsFile(
      path.join(dir, "settings.json"),
      path.join(blocker, "settings.json"),
    );

    const read = await file.read();
    expect(read.settings).toBeNull();
    expect(read.error).toContain("cannot read the pre-rename settings");
    // Not remembered as done: it retries and keeps reporting, rather than running on defaults with
    // the operator's policy still sitting under the old name.
    expect((await file.read()).error).toContain("cannot read the pre-rename settings");
  });

  test("a file that cannot be reached is NOT a missing file: it disables, never defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-auto-compact-settings-"));
    // A regular file where a directory belongs — the real ENOTDIR shape, not a mocked error.
    const blocker = path.join(dir, "jev-auto-compact");
    await fs.writeFile(blocker, "not a directory");
    const file = new SettingsFile(
      path.join(blocker, "settings.json"),
      path.join(dir, "legacy.json"),
    );

    const read = await file.read();
    expect(read.settings).toBeNull();
    expect(read.error).toContain("cannot read settings");
    // And it stays that way: the failure is never cached as a settled state.
    expect((await file.read()).settings).toBeNull();
  });
});
