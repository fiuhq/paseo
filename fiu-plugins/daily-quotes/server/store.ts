import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dayNumber, QuotesStateSchema, seedState, type QuotesState } from "../shared/quotes";

/** Where the host keeps its list: one file, so every client of this daemon reads the same quotes. */
export function quotesFile(home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")) {
  return path.join(home, "daily-quotes", "quotes.json");
}

/**
 * The host's quotes on disk. A missing file is seeded with the operator's list; a file that does
 * not parse is an error, never overwritten, so a bad edit cannot cost the list.
 */
export class QuotesStore {
  // ponytail: changes queue in this process only; two daemon children writing at once keep the last write.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file = quotesFile(),
    private readonly today = () => dayNumber(new Date()),
  ) {}

  read(): Promise<QuotesState> {
    return this.serial(() => this.load());
  }

  update<Result>(change: (state: QuotesState) => { state: QuotesState; result: Result }) {
    return this.serial(async () => {
      const { state, result } = change(await this.load());
      await this.save(state);
      return result;
    });
  }

  private serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<QuotesState> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const seeded = seedState(this.today());
      await this.save(seeded);
      return seeded;
    }
    let parsed: ReturnType<typeof QuotesStateSchema.safeParse>;
    try {
      parsed = QuotesStateSchema.safeParse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`${this.file} is not a daily quotes list: ${(error as Error).message}`);
    }
    if (!parsed.success)
      throw new Error(`${this.file} is not a daily quotes list: ${parsed.error.message}`);
    return parsed.data;
  }

  private async save(state: QuotesState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, this.file);
  }
}
