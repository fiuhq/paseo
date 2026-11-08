import { spawnSync } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrolWorkspace } from "./index.server";

const SHARED = "nm://projects/fiuhq/core/fix-browser-fullpage-screenshot";

/**
 * A container like a fiuhq/core one (main checkout plus a linked worktree, worktree config on, a shared nm://
 * url the global config maps onto MAIN's gate) and a stub `no-mistakes` that records what init would see,
 * then succeeds by creating the derived gate, exits 1, or exits 0 without a gate.
 */
function container(opts: {
  shared: boolean;
  previousPushurl?: string;
  init: "ok" | "fail" | "no-gate";
}) {
  const dir = mkdtempSync(join(tmpdir(), "enrol-it-"));
  const nm = join(dir, "nm");
  const mains = join(nm, "repos", "mainmainmain.git");
  const global = join(dir, "gitconfig");
  writeFileSync(
    global,
    `[url "${mains}"]\n\tinsteadOf = ${SHARED}\n[user]\n\tname = t\n\temail = t@t\n`,
  );
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: global };
  const git = (cwd: string, ...args: string[]) =>
    spawnSync(["git", ...args], { cwd, env })
      .stdout.toString()
      .trim();
  const main = join(dir, "main");
  const wt = join(dir, "wt");
  spawnSync(["git", "init", "-q", "-b", "main", main], { env });
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "remote", "add", "origin", "https://example.invalid/r.git");
  if (opts.shared) git(main, "remote", "add", "no-mistakes", SHARED);
  git(main, "config", "extensions.worktreeConfig", "true");
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  if (opts.previousPushurl)
    git(wt, "config", "--worktree", "remote.no-mistakes.pushurl", opts.previousPushurl);
  const seen = join(dir, "seen");
  const stub = join(dir, "no-mistakes");
  writeFileSync(
    stub,
    `#!/bin/sh
[ "$1 $2" = "daemon status" ] && { echo "  ● daemon running (pid 1)"; exit 0; }
[ "$1" = init ] || exit 2
{ echo "fetch=$(git remote get-url --all no-mistakes 2>/dev/null)"; echo "push=$(git remote get-url --push --all no-mistakes 2>/dev/null)"; echo "wtpush=$(git config --worktree --get remote.no-mistakes.pushurl)"; } > "${seen}"
{ git config --get-all credential.helper; git config --get user.name; } > "${seen}.config"
case "${opts.init}" in
  ok) mkdir -p "$NM_HOME/repos/$(printf %s "$(git rev-parse --show-toplevel)" | shasum -a 256 | cut -c1-12).git" ;;
  fail) exit 1 ;;
esac
`,
  );
  chmodSync(stub, 0o755);
  const scratchParent = join(dir, "tmp");
  mkdirSync(scratchParent);
  return {
    dir,
    wt,
    mains,
    nm,
    git,
    stub,
    seen,
    scratchParent,
    global,
    gate: () => git(wt, "remote", "get-url", "--push", "no-mistakes"),
  };
}

describe("enrolWorkspace against a stub no-mistakes", () => {
  const saved = { ...process.env };
  let c: ReturnType<typeof container>;
  const use = (built: ReturnType<typeof container>) => {
    c = built;
    Object.assign(process.env, {
      HOME: c.dir,
      GIT_CONFIG_GLOBAL: c.global,
      NM_HOME: c.nm,
      NO_MISTAKES_BIN: c.stub,
      TMPDIR: c.scratchParent,
    });
  };
  afterEach(() => {
    process.env = { ...saved };
  });
  const seen = () =>
    Object.fromEntries(
      readFileSync(c.seen, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
  const derived = () => {
    const top = c.git(c.wt, "rev-parse", "--show-toplevel");
    const id = new Bun.CryptoHasher("sha256").update(top).digest("hex").slice(0, 12);
    return join(c.nm, "repos", `${id}.git`);
  };

  test("with a shared nm:// url, init sees fetch and push both on this gate; afterwards only the worktree's pushurl changed and no scratch config is left", async () => {
    use(container({ shared: true, init: "ok" }));
    await enrolWorkspace(c.wt);
    expect(seen()).toEqual({ fetch: derived(), push: derived(), wtpush: derived() });
    expect(c.gate()).toBe(derived());
    expect(c.git(c.wt, "config", "--get", "remote.no-mistakes.url")).toBe(SHARED);
    expect(c.git(c.wt, "remote", "get-url", "no-mistakes")).toBe(c.mains);
    expect(readdirSync(c.scratchParent)).toEqual([]);
  });

  test("with no shared url, no pushurl is written before init, so init's own remote add can run", async () => {
    use(container({ shared: false, init: "ok" }));
    await enrolWorkspace(c.wt);
    expect(seen().wtpush).toBe("");
  });

  test("a failing init puts back the worktree's previous pushurl", async () => {
    use(container({ shared: true, previousPushurl: "/elsewhere/old.git", init: "fail" }));
    await expect(enrolWorkspace(c.wt)).rejects.toThrow();
    expect(c.git(c.wt, "config", "--worktree", "--get", "remote.no-mistakes.pushurl")).toBe(
      "/elsewhere/old.git",
    );
    expect(readdirSync(c.scratchParent)).toEqual([]);
  });

  test("an init that leaves no gate removes the pushurl it wrote when there was none", async () => {
    use(container({ shared: true, init: "no-gate" }));
    await enrolWorkspace(c.wt);
    expect(existsSync(derived())).toBe(false);
    expect(c.git(c.wt, "config", "--worktree", "--get", "remote.no-mistakes.pushurl")).toBe("");
  });

  // Oracle: plain git in the same home, with no GIT_CONFIG_GLOBAL, is what init must keep seeing. A child
  // process, because Bun fixes homedir() at startup, as the daemon's home is fixed in production.
  test.each([
    ["the default XDG path", null, ".config"],
    ["XDG_CONFIG_HOME", "elsewhere", "elsewhere"],
  ])(
    "with no GIT_CONFIG_GLOBAL, init keeps both global files in git's own order (%s)",
    (_, xdgHome, xdgDir) => {
      use(container({ shared: true, init: "ok" }));
      mkdirSync(join(c.dir, xdgDir, "git"), { recursive: true });
      writeFileSync(
        join(c.dir, xdgDir, "git", "config"),
        "[credential]\n\thelper = xdg-helper\n[user]\n\tname = xdg-name\n",
      );
      writeFileSync(join(c.dir, ".gitconfig"), "[user]\n\tname = home-name\n");
      const env = {
        PATH: process.env.PATH,
        HOME: c.dir,
        ...(xdgHome ? { XDG_CONFIG_HOME: join(c.dir, xdgHome) } : {}),
      };
      const driver = `import { enrolWorkspace } from "./index.server"; await enrolWorkspace(${JSON.stringify(c.wt)});`;
      const child = spawnSync([process.execPath, "-e", driver], {
        cwd: import.meta.dir,
        env: { ...env, NM_HOME: c.nm, NO_MISTAKES_BIN: c.stub, TMPDIR: c.scratchParent },
      });
      expect(child.exitCode).toBe(0);
      const atInit = readFileSync(`${c.seen}.config`, "utf8").trim();
      const plainGit = (...args: string[]) =>
        spawnSync(["git", ...args], { cwd: c.wt, env })
          .stdout.toString()
          .trim();
      expect(atInit).toBe(
        `${plainGit("config", "--get-all", "credential.helper")}\n${plainGit("config", "--get", "user.name")}`,
      );
      expect(atInit).toContain("xdg-helper");
      expect(atInit.endsWith("home-name")).toBe(true);
    },
  );
});
