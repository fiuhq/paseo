import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { firstNewWorkspaceTitle } from "./model";

function Title() {
  return null;
}

// Only the fields the picker reads.
function installed(id: string, serverId: string, titleIds: string[]): InstalledPlugin {
  return {
    id,
    serverId,
    newWorkspaceTitles: titleIds.map((titleId) => ({ id: titleId, Component: Title })),
  } as unknown as InstalledPlugin;
}

describe("firstNewWorkspaceTitle", () => {
  it("picks the first title registered on the selected host", () => {
    const plugins = [
      installed("other-host", "b", ["elsewhere"]),
      installed("none", "a", []),
      installed("quotes", "a", ["quote", "second"]),
      installed("later", "a", ["later"]),
    ];

    const selected = firstNewWorkspaceTitle(plugins, "a");

    expect(selected?.plugin.id).toBe("quotes");
    expect(selected?.title.id).toBe("quote");
  });

  it("keeps the default title when the host has none", () => {
    expect(firstNewWorkspaceTitle([installed("quotes", "b", ["quote"])], "a")).toBeNull();
  });
});
