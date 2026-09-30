import { describe, expect, it, vi } from "vitest";

vi.mock("@/attachments/service", () => ({
  releaseAttachmentPreviewUrl: vi.fn(),
  resolveAttachmentPreviewUrl: vi.fn(),
}));

import { attachmentPreviewIdentity, pairedPreviewUrl } from "./use-attachment-preview-url";

const svg = {
  id: "preview_1",
  storageType: "web-indexeddb" as const,
  storageKey: "key-1",
  mimeType: "image/svg+xml",
};
const pdf = { ...svg, mimeType: "application/pdf" };

describe("pairedPreviewUrl", () => {
  it("returns the URL only for the attachment identity it was resolved for", () => {
    const resolved = { identity: attachmentPreviewIdentity(svg)!, url: "blob:svg" };

    expect(pairedPreviewUrl(resolved, attachmentPreviewIdentity(svg))).toBe("blob:svg");
  });

  it("returns null while a different attachment is still resolving", () => {
    const resolved = { identity: attachmentPreviewIdentity(svg)!, url: "blob:svg" };

    expect(pairedPreviewUrl(resolved, attachmentPreviewIdentity(pdf))).toBeNull();
    expect(
      pairedPreviewUrl(resolved, attachmentPreviewIdentity({ ...svg, id: "preview_2" })),
    ).toBeNull();
    expect(pairedPreviewUrl(resolved, attachmentPreviewIdentity(null))).toBeNull();
  });
});
