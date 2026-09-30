import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { ExplorerFile } from "@/stores/session-store";

export const PDF_MIME_TYPE = "application/pdf";

// "%PDF-", the header every PDF opens with. The bytes decide rather than the mime,
// because older daemons report a PDF as application/octet-stream, or as text when
// the whole file happens to be ASCII.
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function explorerFileFromReadResult(file: FileReadResult): ExplorerFile {
  const isPdf = file.kind !== "image" && hasPdfHeader(file.bytes);
  const isText = file.kind === "text" && !isPdf;
  return {
    path: file.path,
    kind: isPdf ? "pdf" : file.kind,
    encoding: isText ? "utf-8" : "none",
    content: isText ? new TextDecoder().decode(file.bytes) : undefined,
    hasBom: isText && hasUtf8Bom(file.bytes),
    mimeType: isPdf ? PDF_MIME_TYPE : file.mime,
    size: file.size,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
  };
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return PDF_HEADER.every((byte, index) => bytes[index] === byte);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
