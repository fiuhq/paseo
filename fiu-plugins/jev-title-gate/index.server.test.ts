import { expect, it } from "bun:test";

import contribute from "./index.server";

it("returns the hook's cleanup, which the daemon requires of every plugin", () => {
  const cleanup = () => {};

  expect(contribute({ addHook: () => cleanup })).toBe(cleanup);
});
