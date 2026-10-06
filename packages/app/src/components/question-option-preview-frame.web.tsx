import { useCallback, useEffect, useMemo, useRef } from "react";
import { buildQuestionPreviewDocument } from "./question-form-card-core";
import type { QuestionOptionPreviewFrameProps } from "./question-option-preview-frame-types";

// A picture taller than this is scaled down to it, as a wide one is to its option's width.
const MAX_PREVIEW_HEIGHT = 360;

/**
 * An HTML option picture in a sandboxed iframe: nothing in it runs, nothing is fetched. The frame
 * takes the picture's own size, scaled down when the picture is wider than its option or taller
 * than MAX_PREVIEW_HEIGHT, so the whole picture always shows.
 */
export function QuestionOptionPreviewFrame({ html, title }: QuestionOptionPreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const document = useMemo(() => buildQuestionPreviewDocument(html), [html]);

  // `allow-same-origin` without `allow-scripts`: no script in the frame can run, and the card
  // can read the picture's drawn size and scale it. The frame's size is set here, not through
  // React state, because laying the picture out across the whole row resizes the frame first.
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const page = frame?.contentDocument?.documentElement;
    const body = frame?.contentDocument?.body;
    const room = frame?.parentElement?.clientWidth;
    if (!frame || !page || !body || !room) return;
    frame.style.width = `${room}px`;
    page.style.zoom = "";
    // The box, or the overflow when positioned content draws outside it.
    const box = body.getBoundingClientRect();
    const width = Math.max(box.width, body.scrollWidth);
    const height = Math.max(box.height, body.scrollHeight);
    if (!width || !height) return;
    const scale = Math.min(1, room / width, MAX_PREVIEW_HEIGHT / height);
    if (scale < 1) page.style.zoom = String(scale);
    frame.style.width = `${Math.ceil(width * scale)}px`;
    frame.style.height = `${Math.ceil(height * scale)}px`;
  }, []);

  // Text rewraps and a picture's scale changes with the room its option gives it.
  useEffect(() => {
    const row = frameRef.current?.parentElement;
    if (!row) return undefined;
    let lastRoom = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === lastRoom) return;
      lastRoom = row.clientWidth;
      measure();
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={document}
      onLoad={measure}
      tabIndex={-1}
      style={frameStyle}
    />
  );
}

// A picture, not a page: the option rows take every tap, so links in a picture go nowhere.
const frameStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: 0,
  border: 0,
  borderRadius: 8,
  pointerEvents: "none",
  background: "transparent",
};
