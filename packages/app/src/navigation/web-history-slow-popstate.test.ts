import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHistory } from "expo-router/build/fork/createMemoryHistory";

// Leaving New workspace for the new workspace pops the stack, which on web is history.go(-1).
// In a busy tab its popstate can land well after 100ms. Expo Router must still read it as its own
// go, not as a Back press, or the app resets to the workspace that was open before New workspace.
function installBrowserWithSlowPopstate(delayMs: number): void {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "/" }];
  let index = 0;
  const browser = Object.assign(new EventTarget(), {
    document: { title: "Paseo" },
    history: {
      get state() {
        return entries[index]?.state ?? null;
      },
      pushState(state: unknown, _title: string, url: string) {
        entries.splice(index + 1, entries.length, { state, url });
        index = entries.length - 1;
      },
      replaceState(state: unknown, _title: string, url: string) {
        entries[index] = { state, url };
      },
      go(delta: number) {
        setTimeout(() => {
          index += delta;
          browser.dispatchEvent(new Event("popstate"));
        }, delayMs);
      },
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("location", { hash: "" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not take a popstate that lands 300ms after its own history.go for a Back press", async () => {
  vi.useFakeTimers();
  installBrowserWithSlowPopstate(300);
  const history = createMemoryHistory();
  history.replace({ path: "/h/srv/workspace/old", state: undefined as never });
  history.push({ path: "/new", state: undefined as never });
  const backPress = vi.fn();
  history.listen(backPress);

  const went = history.go(-1);
  await vi.advanceTimersByTimeAsync(300);
  await went;

  expect(backPress).not.toHaveBeenCalled();
});
