import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addQuote, SEED_QUOTES } from "../shared/quotes";
import { QuotesStore, quotesFile } from "./store";

async function home() {
  return mkdtemp(path.join(os.tmpdir(), "daily-quotes-"));
}

describe("QuotesStore", () => {
  test("seeds a new host with the operator's list and writes it once", async () => {
    const file = quotesFile(await home());
    const store = new QuotesStore(file, () => 100);
    expect(await store.read()).toEqual({
      version: 1,
      enabled: true,
      quotes: [...SEED_QUOTES],
      anchorDay: 100,
    });
    expect(JSON.parse(await readFile(file, "utf8")).quotes).toEqual([...SEED_QUOTES]);
    expect(await readdir(path.dirname(file))).toEqual(["quotes.json"]);
  });

  test("keeps every change from a burst of writes", async () => {
    const file = quotesFile(await home());
    const store = new QuotesStore(file, () => 100);
    await Promise.all(
      ["one", "two", "three"].map((text) =>
        store.update((state) => ({ state: addQuote(state, text, 100), result: null })),
      ),
    );
    expect((await new QuotesStore(file).read()).quotes).toHaveLength(SEED_QUOTES.length + 3);
  });

  test("refuses a file it cannot read rather than replacing the list", async () => {
    const file = quotesFile(await home());
    await new QuotesStore(file, () => 100).read();
    await writeFile(file, JSON.stringify({ quotes: "not a list" }));
    await expect(new QuotesStore(file).read()).rejects.toThrow("is not a daily quotes list");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ quotes: "not a list" });
  });
});
