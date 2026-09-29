import { describe, expect, it } from "vitest";

import { createAppWindowOpenHandler, createExternalUrlOpener } from "./opener";

describe("desktop opener", () => {
  it("passes a canonical web URL to its external owner", async () => {
    const opened: string[] = [];
    const open = createExternalUrlOpener({
      open: async (url) => {
        opened.push(url);
      },
    });

    await open("https://example.com/docs#install");

    expect(opened).toEqual(["https://example.com/docs#install"]);
  });

  it("does not hand non-web or relative URLs to the external owner", async () => {
    const opened: string[] = [];
    const open = createExternalUrlOpener({
      open: async (url) => {
        opened.push(url);
      },
    });

    for (const input of [
      "file:///private/data",
      "javascript:alert(1)",
      "paseo://settings",
      "/docs",
      null,
    ]) {
      await expect(open(input)).rejects.toThrow("Only HTTP(S) URLs can open externally.");
    }

    expect(opened).toEqual([]);
  });
});

describe("app window open handler", () => {
  it("opens a web popup in the system browser instead of an Electron window", async () => {
    const opened: string[] = [];
    const handle = createAppWindowOpenHandler(
      {
        open: async (url) => {
          opened.push(url);
        },
      },
      () => undefined,
    );

    expect(handle({ url: "https://mockup.example.com:39922/" })).toEqual({
      action: "deny",
    });
    await Promise.resolve();

    expect(opened).toEqual(["https://mockup.example.com:39922/"]);
  });

  it("drops a popup that is not a web URL", async () => {
    const opened: string[] = [];
    const handle = createAppWindowOpenHandler(
      {
        open: async (url) => {
          opened.push(url);
        },
      },
      () => undefined,
    );

    for (const url of ["about:blank", "javascript:alert(1)", "file:///private/data", "paseo://x"]) {
      expect(handle({ url })).toEqual({ action: "deny" });
    }
    await Promise.resolve();

    expect(opened).toEqual([]);
  });

  it("reports a system browser failure instead of throwing from the handler", async () => {
    const failures: unknown[] = [];
    const failure = new Error("no default browser");
    const handle = createAppWindowOpenHandler(
      {
        open: async () => {
          throw failure;
        },
      },
      (error) => failures.push(error),
    );

    expect(handle({ url: "https://example.com/" })).toEqual({ action: "deny" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failures).toEqual([failure]);
  });
});
