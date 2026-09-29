interface ExternalUrlOwner {
  open(url: string): Promise<void>;
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

const asExternalUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string" || !URL.canParse(input)) return undefined;
  const candidate = new URL(input);
  return EXTERNAL_PROTOCOLS.has(candidate.protocol) ? candidate : undefined;
};

export function createExternalUrlOpener(owner: ExternalUrlOwner) {
  return async (candidate: unknown): Promise<void> => {
    const url = asExternalUrl(candidate);
    if (url === undefined) {
      throw new Error("Only HTTP(S) URLs can open externally.");
    }
    return owner.open(url.href);
  };
}

// A frame inside the app window, such as the HTML file preview, can open a popup.
// It never becomes an Electron window. A web URL opens in the system browser, like
// every other link in the app, and anything else is dropped.
export function createAppWindowOpenHandler(
  owner: ExternalUrlOwner,
  onOpenFailed: (error: unknown) => void,
) {
  return ({ url }: { url: string }): { action: "deny" } => {
    const external = asExternalUrl(url);
    if (external !== undefined) owner.open(external.href).catch(onOpenFailed);
    return { action: "deny" };
  };
}
