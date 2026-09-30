import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { FilePdfPreviewProps } from "./pdf-preview";

// The browser's own PDF viewer renders the file, so zoom, find, print, and text
// selection come with it. The frame has no `sandbox`: Chromium will not run its
// PDF viewer inside a sandboxed frame. The frame's source is a blob: URL of the
// file's bytes, stored with the type application/pdf, which is what makes the
// browser hand it to the viewer rather than download it or parse it as a page.
// Electron needs `webPreferences.plugins` on the app window for the same viewer.
const iframeStyle = {
  flex: 1,
  minHeight: 0,
  border: "none",
} as const;

function WebFilePdfPreview({ uri, testID }: FilePdfPreviewProps) {
  const { t } = useTranslation();
  return (
    // eslint-disable-next-line react/iframe-missing-sandbox -- the PDF viewer does not run in a sandboxed frame; see above.
    <iframe
      data-testid={testID}
      title={t("panels.file.editor.preview")}
      src={uri}
      referrerPolicy="no-referrer"
      style={iframeStyle}
    />
  );
}

export const FilePdfPreview: ComponentType<FilePdfPreviewProps> | null = WebFilePdfPreview;
