import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { explorerFileFromReadResult } from "./read-result";

function textRead(bytes: Uint8Array): FileReadResult {
  return {
    bytes,
    mime: "text/plain",
    size: bytes.byteLength,
    path: "notes.txt",
    kind: "text",
    modifiedAt: "2026-07-21T00:00:00.000Z",
  };
}

describe("explorerFileFromReadResult", () => {
  it("records and hides a leading UTF-8 BOM", () => {
    const file = explorerFileFromReadResult(
      textRead(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
    );

    expect(file).toMatchObject({ content: "hi", hasBom: true });
  });

  it("does not mark BOM-free text or non-leading U+FEFF as BOM files", () => {
    const plain = explorerFileFromReadResult(textRead(new TextEncoder().encode("hi")));
    const embedded = explorerFileFromReadResult(
      textRead(new Uint8Array([0x68, 0x69, 0xef, 0xbb, 0xbf])),
    );

    expect(plain.hasBom).toBe(false);
    expect(embedded.hasBom).toBe(false);
  });

  it("classifies a PDF by its header and types it application/pdf", () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("%PDF-1.7\n"),
      0x25,
      0xe2,
      0xe3,
      0xcf,
      0xd3,
    ]);
    const binaryRead: FileReadResult = {
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      path: "report.pdf",
      kind: "binary",
      modifiedAt: "2026-07-21T00:00:00.000Z",
    };

    expect(explorerFileFromReadResult(binaryRead)).toMatchObject({
      kind: "pdf",
      mimeType: "application/pdf",
      encoding: "none",
      content: undefined,
    });
  });

  it("classifies an all-ASCII PDF that was read as text as a PDF", () => {
    const file = explorerFileFromReadResult(
      textRead(new TextEncoder().encode("%PDF-1.4\n%%EOF\n")),
    );

    expect(file).toMatchObject({ kind: "pdf", mimeType: "application/pdf", content: undefined });
  });

  it("classifies PDF bytes read under an image label as a PDF", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
    const file = explorerFileFromReadResult({
      bytes,
      mime: "image/png",
      size: bytes.byteLength,
      path: "report.png",
      kind: "image",
      modifiedAt: "2026-07-21T00:00:00.000Z",
    });

    expect(file).toMatchObject({ kind: "pdf", mimeType: "application/pdf" });
  });

  it("leaves other binaries unpreviewable", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    const file = explorerFileFromReadResult({
      bytes,
      mime: "application/octet-stream",
      size: bytes.byteLength,
      path: "archive.zip",
      kind: "binary",
      modifiedAt: "2026-07-21T00:00:00.000Z",
    });

    expect(file).toMatchObject({ kind: "binary", mimeType: "application/octet-stream" });
  });
});
