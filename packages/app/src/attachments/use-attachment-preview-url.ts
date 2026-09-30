import { useEffect, useRef, useState } from "react";
import type { AttachmentMetadata } from "@/attachments/types";
import { releaseAttachmentPreviewUrl, resolveAttachmentPreviewUrl } from "@/attachments/service";

export function attachmentPreviewIdentity(
  attachment: Pick<AttachmentMetadata, "id" | "storageType" | "storageKey" | "mimeType"> | null | undefined,
): string | null {
  return attachment
    ? JSON.stringify([attachment.id, attachment.storageType, attachment.storageKey, attachment.mimeType])
    : null;
}

export function pairedPreviewUrl(
  resolved: { identity: string; url: string } | null,
  identity: string | null,
): string | null {
  return resolved && resolved.identity === identity ? resolved.url : null;
}

export function useAttachmentPreviewUrl(
  attachment: AttachmentMetadata | null | undefined,
): string | null {
  const [resolved, setResolved] = useState<{ identity: string; url: string } | null>(null);
  const activeAttachmentRef = useRef<AttachmentMetadata | null>(null);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;

  const id = attachment?.id;
  const storageType = attachment?.storageType;
  const storageKey = attachment?.storageKey;
  const mimeType = attachment?.mimeType;
  const identity = attachmentPreviewIdentity(attachment);

  useEffect(() => {
    let disposed = false;
    let currentUrl: string | null = null;
    const current = attachmentRef.current;

    activeAttachmentRef.current = current ?? null;
    if (!current) {
      setResolved(null);
      return;
    }
    const currentIdentity = attachmentPreviewIdentity(current)!;

    void (async () => {
      try {
        const url = await resolveAttachmentPreviewUrl(current);
        if (disposed) {
          await releaseAttachmentPreviewUrl({ attachment: current, url });
          return;
        }
        currentUrl = url;
        setResolved({ identity: currentIdentity, url });
      } catch (error) {
        console.error("[attachments] Failed to resolve preview URL", {
          attachmentId: current.id,
          error,
        });
        if (!disposed) {
          setResolved(null);
        }
      }
    })();

    return () => {
      disposed = true;
      const activeAttachment = activeAttachmentRef.current;
      if (!currentUrl || !activeAttachment) {
        return;
      }
      void releaseAttachmentPreviewUrl({
        attachment: activeAttachment,
        url: currentUrl,
      });
    };
  }, [id, storageType, storageKey, mimeType]);

  return pairedPreviewUrl(resolved, identity);
}
