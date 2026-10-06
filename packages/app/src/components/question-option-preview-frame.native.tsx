import { useCallback, useMemo } from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { buildQuestionPreviewDocument } from "./question-form-card-core";
import type { QuestionOptionPreviewFrameProps } from "./question-option-preview-frame-types";

const WEBVIEW_ORIGIN_WHITELIST = ["*"];
// ponytail: a fixed height, because measuring the drawn page needs JavaScript in the WebView.
const PREVIEW_HEIGHT = 240;

/** An HTML option preview in a WebView with JavaScript off that loads nothing else. */
export function QuestionOptionPreviewFrame({ html, title }: QuestionOptionPreviewFrameProps) {
  const source = useMemo(() => ({ html: buildQuestionPreviewDocument(html) }), [html]);
  const handleShouldStartLoad = useCallback(
    (load: { url: string }) => load.url === "about:blank" || load.url.startsWith("data:"),
    [],
  );

  return (
    <View style={styles.frame} pointerEvents="none" accessible accessibilityLabel={title}>
      <WebView
        source={source}
        originWhitelist={WEBVIEW_ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        javaScriptEnabled={false}
        scrollEnabled={false}
        bounces={false}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        style={styles.webView}
      />
    </View>
  );
}

const styles = RNStyleSheet.create({
  frame: { height: PREVIEW_HEIGHT },
  webView: { backgroundColor: "#fff" },
});
