import { ipc } from "../ipc/client";
import type { Attachment } from "./attachments";

/**
 * Turning attached images into bytes the agent can be sent.
 *
 * Kept out of `attachments.ts` on purpose: that module is pure and testable in
 * node, and this one needs a canvas and the filesystem.
 *
 * The work here is shrinking. A 4MB screenshot is ~5.5MB of base64 on a single
 * JSONL line, which is slow to send, expensive in context, and no more legible
 * to the model than a smaller copy. prime-agent's own `attach-image` skill
 * applies the same limits for the same reason.
 */

/** Beyond this, the picture is re-encoded smaller. */
const MAX_EDGE = 1200;

/** Base64 length above which shrinking is worth doing at all. */
const SHRINK_ABOVE = 350 * 1024;

/**
 * Load bytes for every image attachment, leaving files alone.
 *
 * An image that cannot be read is returned without data rather than throwing:
 * `imagePayload` drops it, so one unreadable screenshot costs you the picture
 * and not the whole message. The reason is surfaced by the caller.
 */
export async function withImageData(
  attachments: Attachment[],
): Promise<{ loaded: Attachment[]; failed: string[] }> {
  const failed: string[] = [];
  const loaded = await Promise.all(
    attachments.map(async (a) => {
      if (a.kind !== "image" || a.data) return a;
      try {
        const raw = await ipc.attachmentRead(a.path);
        const shrunk = await shrink(raw.base64, raw.mimeType);
        return { ...a, data: shrunk.base64, mimeType: shrunk.mimeType };
      } catch {
        failed.push(a.name);
        return a;
      }
    }),
  );
  return { loaded, failed };
}

/**
 * Re-encode an oversized image smaller, or return it untouched.
 *
 * Falls back to the original on any failure. A picture that is too big is worth
 * far more than no picture, and the agent's own limits are advisory rather than
 * a hard rejection.
 */
async function shrink(
  base64: string,
  mimeType: string,
): Promise<{ base64: string; mimeType: string }> {
  if (base64.length <= SHRINK_ABOVE) return { base64, mimeType };
  try {
    const img = await decode(`data:${mimeType};base64,${base64}`);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { base64, mimeType };
    ctx.drawImage(img, 0, 0, w, h);

    // JPEG regardless of what came in: at this size the saving over PNG is
    // large and the loss is invisible for what these are — screenshots and
    // photographs. An animation would lose its frames, which is why this only
    // happens to images already too big to send comfortably.
    const url = canvas.toDataURL("image/jpeg", 0.85);
    const encoded = url.slice(url.indexOf(",") + 1);
    if (!encoded || encoded.length >= base64.length) return { base64, mimeType };
    return { base64: encoded, mimeType: "image/jpeg" };
  } catch {
    return { base64, mimeType };
  }
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode"));
    img.src = src;
  });
}

/** A thumbnail for the pill. Small enough to hold for several at once. */
export async function thumbnail(path: string): Promise<string | null> {
  try {
    const raw = await ipc.attachmentRead(path);
    return `data:${raw.mimeType};base64,${raw.base64}`;
  } catch {
    return null;
  }
}
