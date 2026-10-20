import { useCallback, useMemo, useRef } from "react";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";
import { withPreviewCsp } from "./html-preview-csp";
import { htmlPreviewNavigationKind } from "./html-preview-navigation";

// Only the document Paseo hands the WebView loads into the pane. The page may load
// HTTPS resources (see html-preview-csp.ts), but navigations it attempts afterwards
// are refused, so a link, a `location.href` assignment, or a meta refresh cannot
// replace the pane with a remote page. Storage and cache stay off so a page leaves
// nothing behind between opens.
//
// This guard is not absolute, and SECURITY.md says so: the decision runs in app
// JS, and Android's WebView allows a navigation whose decision doesn't return in
// time. A stalled JS thread is therefore a window.
//
// `originWhitelist: ["*"]` is what makes that guarantee hold. react-native-webview
// checks the whitelist *before* calling onShouldStartLoadWithRequest and hands
// anything that fails it to `Linking.openURL` — so a narrow whitelist would route
// custom schemes straight to the system browser without this guard ever seeing
// them. Matching everything forces every scheme through the callback below.
const ORIGIN_WHITELIST = ["*"];

// Pinning the base URL is what makes the guard below sound. Android loads
// `source={{ html }}` through `loadDataWithBaseURL`, and a programmatic load is not
// reliably reported to onShouldStartLoadWithRequest — so the latch may still be
// unset when the page makes its first move. Naming an inert base means the only
// URLs that can pass as "initial" are inert ones. `data:text/html` must NOT be
// allowed here: a page could navigate itself to a data document of its own, which
// would arrive with no injected policy and a clean slate to egress from.
const BASE_URL = "about:blank";

export function FileHtmlPreview({ html, testID }: { html: string; testID?: string }) {
  const document = useMemo(() => withPreviewCsp(html), [html]);
  const source = useMemo(() => ({ html: document, baseUrl: BASE_URL }), [document]);
  // Latched per document rather than once for the lifetime of the WebView: the
  // file pane re-renders with new content on every live-file refresh, and each of
  // those is a fresh initial load that has to be allowed through.
  const loadedDocumentRef = useRef<string | null>(null);
  const allowOnlyInitialDocument = useCallback(
    ({ url }: { url: string }) => {
      const navigationKind = htmlPreviewNavigationKind(url);
      if (navigationKind === "fragment") return true;
      if (navigationKind === "blocked") return false;
      if (loadedDocumentRef.current === document) return false;
      loadedDocumentRef.current = document;
      return true;
    },
    [document],
  );

  return (
    <WebView
      testID={testID}
      style={styles.webview}
      source={source}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={allowOnlyInitialDocument}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
    />
  );
}

const styles = StyleSheet.create(() => ({
  webview: {
    flex: 1,
    backgroundColor: "white",
  },
}));
