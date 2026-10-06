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
    body.style.margin = "0";
    // The body's box widened to every descendant, so content positioned outside it counts.
    const origin = body.getBoundingClientRect();
    let left = 0;
    let top = 0;
    let right = Math.max(origin.width, body.scrollWidth);
    let bottom = Math.max(origin.height, body.scrollHeight);
    for (const element of body.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height && !element.scrollWidth && !element.scrollHeight) continue;
      left = Math.min(left, rect.left - origin.left);
      top = Math.min(top, rect.top - origin.top);
      right = Math.max(right, rect.right - origin.left, rect.left - origin.left + element.scrollWidth);
      bottom = Math.max(bottom, rect.bottom - origin.top, rect.top - origin.top + element.scrollHeight);
    }
    if (left < 0 || top < 0) body.style.margin = `${-Math.min(top, 0)}px 0 0 ${-Math.min(left, 0)}px`;
    const width = right - left;
    const height = bottom - top;
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
