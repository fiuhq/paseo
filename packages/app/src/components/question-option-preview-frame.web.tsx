import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import { wheelZoomFactor } from "@/components/zoomable-viewport/geometry";
import type { ZoomableViewportHandle } from "@/components/zoomable-viewport/types";
import {
  buildQuestionPreviewDocument,
  questionPreviewBox,
  questionPreviewStateMessage,
  readQuestionPreviewFrameMessage,
  type QuestionPreviewSize,
} from "./question-form-card-core";
import type { QuestionOptionPreviewFrameProps } from "./question-option-preview-frame-types";

// Until the frame reports its picture, the viewport has nothing to fit.
const NOT_MEASURED: QuestionPreviewSize = { width: 1, height: 1 };

// A picture measured for one option width. Text wraps to the frame it is laid out in, so a new
// width is measured again with the frame laid out at that width.
interface Measurement {
  document: string;
  room: number;
  size: QuestionPreviewSize;
}

// The frame's width is a whole number of pixels; the option's may not be.
const sameWidth = (a: number, b: number) => Math.abs(a - b) <= 1;

/**
 * An HTML option picture, live: its own scripts run in a sandboxed frame with an opaque origin,
 * so it can be clicked through but cannot reach the app, and nothing is fetched. The picture is
 * fitted whole into its option; the viewport around it zooms (Ctrl/⌘ and the wheel, a pinch, and
 * the toolbar it shows while the picture is drawn smaller than its own size) and pans while zoomed
 * in (the wheel, a touch drag). The frame is laid out at the option's width, or at the picture's own
 * width when the picture is wider, and only drawn smaller or larger, so zooming never reflows it.
 */
export function QuestionOptionPreviewFrame({ html, title }: QuestionOptionPreviewFrameProps) {
  const roomRef = useRef<HTMLDivElement | null>(null);
  const viewportBoxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const viewportRef = useRef<ZoomableViewportHandle | null>(null);
  const document = useMemo(() => buildQuestionPreviewDocument(html), [html]);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [room, setRoom] = useState(0);
  // A new picture is fitted from its own size, never the previous picture's. Until it is measured
  // for this width, the last measurement draws it, and the frame is laid out at the new width.
  const drawn = measurement?.document === document ? measurement.size : null;
  const picture = drawn && measurement && sameWidth(measurement.room, room) ? drawn : null;
  // Never narrower than the option, so a picture that grows (a click opens a panel) has room to;
  // wider when the picture is, so it is laid out at its own width and drawn smaller.
  const layoutWidth = picture ? Math.max(room, picture.width) : room;

  useEffect(() => {
    const element = roomRef.current;
    if (!element) return undefined;
    setRoom(element.clientWidth);
    const observer = new ResizeObserver(() => setRoom(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function receive(event: MessageEvent) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readQuestionPreviewFrameMessage(event.data);
      if (!message) return;
      if (message.type === "size") {
        // Measured at the option's width, or a change while laid out at the picture's own width.
        const forThisWidth =
          sameWidth(message.viewport, room) ||
          (picture && sameWidth(message.viewport, layoutWidth));
        if (!forThisWidth) return;
        setMeasurement({ document, room, size: { width: message.width, height: message.height } });
        return;
      }
      if (message.type === "pan") {
        viewportRef.current?.panBy({ x: message.dx, y: message.dy });
        return;
      }
      if (!message.zoom) {
        viewportRef.current?.panBy({ x: -message.deltaX, y: -message.deltaY });
        return;
      }
      // The frame reports its pointer in the picture's own pixels; the frame is drawn at a scale.
      const onScreen = frame.getBoundingClientRect();
      const viewportBox = viewportBoxRef.current?.getBoundingClientRect();
      if (!viewportBox || !frame.offsetWidth) return;
      const scale = onScreen.width / frame.offsetWidth;
      viewportRef.current?.zoomBy(wheelZoomFactor(message.deltaY), {
        x: onScreen.left - viewportBox.left + message.x * scale,
        y: onScreen.top - viewportBox.top + message.y * scale,
      });
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [document, layoutWidth, picture, room]);

  // While zoomed in, the frame hands the card its wheel and touch drags so they pan the picture.
  const tellFrame = useCallback((scale: number) => {
    frameRef.current?.contentWindow?.postMessage(questionPreviewStateMessage(scale > 1), "*");
  }, []);

  const box = drawn && room ? questionPreviewBox(drawn, room) : null;
  const fit = drawn && box ? Math.min(box.width / drawn.width, box.height / drawn.height) : 1;
  const viewportBoxStyle = useMemo<React.CSSProperties>(
    () => ({ ...viewportBoxDomStyle, width: box?.width ?? "100%", height: box?.height ?? 0 }),
    [box?.height, box?.width],
  );
  const frameStyle = useMemo<React.CSSProperties>(
    () => ({
      ...frameDomStyle,
      width: layoutWidth || "100%",
      height: drawn?.height ?? 0,
      transform: `scale(${fit})`,
    }),
    [drawn?.height, fit, layoutWidth],
  );

  return (
    <div ref={roomRef} style={roomDomStyle}>
      <div ref={viewportBoxRef} style={viewportBoxStyle}>
        <ZoomableViewport
          ref={viewportRef}
          contentSize={drawn ?? NOT_MEASURED}
          minScale={1}
          onScaleChange={tellFrame}
          testID="question-option-preview"
          toolbarPlacement="bottom"
          toolbarVisibility={fit < 1 ? "always" : "hidden"}
        >
          <iframe
            ref={frameRef}
            title={title}
            sandbox="allow-scripts"
            srcDoc={document}
            style={frameStyle}
          />
        </ZoomableViewport>
      </div>
    </div>
  );
}

const roomDomStyle: React.CSSProperties = { width: "100%" };
const viewportBoxDomStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderRadius: 8,
  overflow: "hidden",
  background: "#fff",
};
const frameDomStyle: React.CSSProperties = {
  display: "block",
  border: 0,
  background: "transparent",
  transformOrigin: "0 0",
};
