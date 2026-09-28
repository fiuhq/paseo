import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withPreviewCspWeb } from "./html-preview-csp";

// The frame runs a page the way a browser tab would, minus the Paseo app's
// privileges. It never gets `allow-same-origin`: a srcdoc frame with that token
// takes the app's origin, and with it the daemon session. The page stays in an
// opaque origin that cannot reach the app's DOM, cookies, or storage (storage APIs
// throw inside it). It never gets `allow-top-navigation*`, so it cannot replace the
// app with a page of its own.
//
// Everything else a web app needs is on. Without `allow-forms` a form's submit
// event never fires, which breaks every framework's onSubmit. Dialogs, downloads
// (a page exports its state that way), and popups work. `allow-popups-to-escape-sandbox`
// makes a target="_blank" link open an ordinary tab instead of one that inherits
// this sandbox. On desktop, main.ts hands those popups to the system browser. A
// plain link with no target also opens in a new tab, like a chat link, instead of
// replacing the preview — see the click interceptor in html-preview-csp.ts.
// Clipboard writes and fullscreen are delegated so copy buttons and fullscreen
// charts work.
//
// Which hosts the page can reach is the CSP's job (html-preview-csp.ts).
const SANDBOX = [
  "allow-scripts",
  "allow-forms",
  "allow-modals",
  "allow-downloads",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
].join(" ");

const PERMISSIONS = "clipboard-write; fullscreen";

const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
  backgroundColor: "white",
} as const;

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  const { t } = useTranslation();
  const document = useMemo(() => withPreviewCspWeb(html), [html]);
  return (
    <iframe
      data-testid={testID}
      title={t("panels.file.editor.preview")}
      srcDoc={document}
      sandbox={SANDBOX}
      allow={PERMISSIONS}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}
