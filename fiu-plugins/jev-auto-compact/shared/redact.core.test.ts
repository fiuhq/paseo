import { describe, expect, test } from "bun:test";

import { byteLength, clipBytes, clipTo, redact } from "./redact.core";

describe("redact", () => {
  test("removes the identifiers a turn description carries", () => {
    const out = redact(
      "opened https://github.com/acme-corp/billing/pull/42 from /Users/someone/work/billing after mailing dev@acme-corp.io",
    );
    expect(out).not.toContain("github.com");
    expect(out).not.toContain("/Users/someone");
    expect(out).not.toContain("dev@acme-corp.io");
    expect(out).toContain("<url>");
    expect(out).toContain("<path>");
    expect(out).toContain("<email>");
  });

  test("removes hosts, addresses and long opaque tokens", () => {
    const out = redact(
      "deployed to api.internal.acme.io (10.1.2.3), run 3f2a9c81d4e5b6a7c8d9, key tok_ABCDEFGHIJKLMNOPQRSTUVWX",
    );
    expect(out).toContain("<host>");
    expect(out).toContain("<id>");
    expect(out).not.toContain("10.1.2.3");
    expect(out).not.toContain("3f2a9c81d4e5b6a7c8d9");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX");
  });

  test("removes configured names a pattern cannot know", () => {
    expect(redact("the Northwind tenant is blocked", ["northwind"])).toBe(
      "the <name> tenant is blocked",
    );
  });

  test("ignores a one-character configured word, which would shred the text", () => {
    expect(redact("a plain sentence", ["a"])).toBe("a plain sentence");
  });

  test("leaves ordinary prose intact, so the judge still has something to read", () => {
    const prose = "I finished the migration and every test passes.";
    expect(redact(prose)).toBe(prose);
  });
});

describe("clipBytes", () => {
  test("measures what is sent, not what JavaScript counts", () => {
    const chinese = "工作完成了".repeat(20); // 5 chars x 3 bytes x 20
    expect(chinese.length).toBe(100);
    expect(byteLength(chinese)).toBe(300);
    expect(byteLength(clipBytes(chinese, 60))).toBeLessThanOrEqual(60);
  });

  test("leaves text that already fits exactly as it is", () => {
    expect(clipBytes("finished the migration", 2_048)).toBe("finished the migration");
  });

  test("never cuts a character in half", () => {
    // The budget lands mid-character: the prefix must stop before it, not inside it.
    const clipped = clipBytes("工作工作工作", 11);
    expect(byteLength(clipped)).toBeLessThanOrEqual(11);
    expect(clipped).not.toContain("�");
  });

  test("clipTo collapses whitespace", () => {
    expect(clipTo("one\n\n  two   three", 100)).toBe("one two three");
  });

  test("clipTo redacts first, so no identifier survives the cut", () => {
    expect(clipTo("see https://secret.example.com/a now", 200)).toBe("see <url> now");
  });
});
