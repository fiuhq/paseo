import type { ComponentType } from "react";

export interface FilePdfPreviewProps {
  uri: string;
  testID?: string;
}

// iOS and Android have no PDF preview, so the pane shows the file as an unpreviewable
// binary: Android's WebView has no PDF viewer, and the app does not bundle a renderer.
export const FilePdfPreview: ComponentType<FilePdfPreviewProps> | null = null;
