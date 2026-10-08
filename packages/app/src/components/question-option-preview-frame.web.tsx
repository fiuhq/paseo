import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import { wheelZoomFactor } from "@/components/zoomable-viewport/geometry";
import type { ZoomableViewportHandle } from "@/components/zoomable-viewport/types";
import {
  buildQuestionPreviewDocument,
  measureQuestionPreviewLayout,
  questionPreviewBox,
  questionPreviewStateMessage,
  readQuestionPreviewFrameMessage,
  startQuestionPreviewLayout,
  type QuestionPreviewLayout,
  type QuestionPreviewSize,
} from "./question-form-card-core";
import type { QuestionOptionPreviewFrameProps } from "./question-option-preview-frame-types";

// Until the frame reports its picture, the viewport has nothing to fit.
const NOT_MEASURED: QuestionPreviewSize = { width: 1, height: 1 };

// Which loads of the frame the card asked for. A load it did not ask for is the picture's page
// navigating itself away: the card puts the picture back once, and stops a page that leaves again.
interface FrameLoads {
  document: string;
  restored: boolean;
  restoring: boolean;
}

// Text wraps to the frame it is laid out in, so a new picture or a new option width is laid out
// again from the option's width. Until it is measured there, the same picture's last measurement
// draws it.
function layoutFor(kept: QuestionPreviewLayout | null, document: string, room: number) {
  const current = kept?.document === document && kept.room === room ? kept : null;
  const layout = current ?? (room ? startQuestionPreviewLayout(document, room) : null);
  const drawn = layout?.picture ?? (kept?.document === document ? kept.picture : null);
  const box = drawn && room ? questionPreviewBox(drawn, room) : null;
  const fit = drawn && box ? Math.min(box.width / drawn.width, box.height / drawn.height) : 1;
  return { layout, drawn, box, fit };
}

/**
 * An HTML option picture, live: its own scripts run in a sandboxed frame with an opaque origin,
 * so it can be clicked through but cannot reach the app, and nothing is fetched. The picture is
 * fitted whole into its option; the viewport around it zooms (Ctrl/⌘ and the wheel, a pinch, and
 * the toolbar it shows while the picture is drawn smaller than its own size) and pans while zoomed
 * in (the wheel, a touch drag). The frame is laid out as `measureQuestionPreviewLayout` decides and
 * only drawn smaller or larger, so zooming never reflows the picture.
 */
export function QuestionOptionPreviewFrame({ html, title }: QuestionOptionPreviewFrameProps) {
  const { t } = useTranslation();
  const roomRef = useRef<HTMLDivElement | null>(null);
  const viewportBoxRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const viewportRef = useRef<ZoomableViewportHandle | null>(null);
  const document = useMemo(() => buildQuestionPreviewDocument(html), [html]);
  const [kept, setKept] = useState<QuestionPreviewLayout | null>(null);
  const [room, setRoom] = useState(0);
  const loadsRef = useRef<FrameLoads | null>(null);
  const scaleRef = useRef(1);
  const [stopped, setStopped] = useState<string | null>(null);
  const { layout, drawn, box, fit } = layoutFor(kept, document, room);

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
        if (!room) return;
        const size = { width: message.width, height: message.height };
        const frameSize = { width: message.frameWidth, height: message.frameHeight };
        setKept((previous) =>
          measureQuestionPreviewLayout(
            previous?.document === document && previous.room === room
              ? previous
              : startQuestionPreviewLayout(document, room),
            size,
            frameSize,
          ),
        );
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
  }, [document, room]);

  // A page the card loaded starts unzoomed; it is told the viewport's scale as it stands.
  const handleLoad = useCallback(() => {
    const frame = frameRef.current;
    const loads = loadsRef.current;
    if (!frame) return;
    const resend = () =>
      frame.contentWindow?.postMessage(questionPreviewStateMessage(scaleRef.current > 1), "*");
    if (!loads || loads.document !== document) {
      loadsRef.current = { document, restored: false, restoring: false };
      resend();
      return;
    }
    if (loads.restoring) {
      loads.restoring = false;
      resend();
      return;
    }
    if (loads.restored) {
      setStopped(document);
      return;
    }
    loads.restored = true;
    loads.restoring = true;
    frame.setAttribute("srcdoc", document);
  }, [document]);

  // While zoomed in, the frame hands the card its wheel and touch drags so they pan the picture.
  const tellFrame = useCallback((scale: number) => {
    scaleRef.current = scale;
    frameRef.current?.contentWindow?.postMessage(questionPreviewStateMessage(scale > 1), "*");
  }, []);

  const viewportBoxStyle = useMemo<React.CSSProperties>(
    () => ({ ...viewportBoxDomStyle, width: box?.width ?? "100%", height: box?.height ?? 0 }),
    [box?.height, box?.width],
  );
  const frameStyle = useMemo<React.CSSProperties>(
    () => ({
      ...frameDomStyle,
      width: layout?.frame.width ?? "100%",
      height: layout?.frame.height ?? 0,
      transform: `scale(${fit})`,
    }),
    [fit, layout?.frame.height, layout?.frame.width],
  );

  if (stopped === document) {
    return <Text style={styles.stopped}>{t("message.question.previewStopped")}</Text>;
  }

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
            onLoad={handleLoad}
            style={frameStyle}
          />
        </ZoomableViewport>
      </div>
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  stopped: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

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
