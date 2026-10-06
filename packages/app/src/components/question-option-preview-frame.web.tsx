import { useCallback, useMemo, useRef, useState } from "react";
import { buildQuestionPreviewDocument } from "./question-form-card-core";
import type { QuestionOptionPreviewFrameProps } from "./question-option-preview-frame-types";

// ponytail: a taller preview is clipped at this height; let the frame scroll if one needs it.
const MAX_PREVIEW_HEIGHT = 360;
const INITIAL_PREVIEW_HEIGHT = 120;

/** An HTML option preview in a sandboxed iframe: nothing in it runs, nothing is fetched. */
export function QuestionOptionPreviewFrame({ html, title }: QuestionOptionPreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(INITIAL_PREVIEW_HEIGHT);
  const document = useMemo(() => buildQuestionPreviewDocument(html), [html]);
  const style = useMemo(() => ({ ...frameStyle, height }), [height]);

  // `allow-same-origin` without `allow-scripts`: no script in the frame can run, and the card
  // can read the drawn height to fit the frame to the preview.
  const handleLoad = useCallback(() => {
    const drawn = frameRef.current?.contentDocument?.body.scrollHeight;
    if (drawn) setHeight(Math.min(drawn, MAX_PREVIEW_HEIGHT));
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={document}
      onLoad={handleLoad}
      tabIndex={-1}
      style={style}
    />
  );
}

// A picture, not a page: the option rows take every tap, so links in a preview go nowhere.
const frameStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  border: 0,
  pointerEvents: "none",
  background: "#fff",
};
