/**
 * Files and images attached to a chat message.
 *
 * Two kinds, and the difference is not cosmetic — it decides how the thing
 * reaches the agent:
 *
 * - An **image** is sent as bytes, in prime-agent's `images` RPC field, so the
 *   model actually sees the pixels. Describing a screenshot in words is exactly
 *   what attaching one is meant to avoid.
 * - **Anything else** is sent as an absolute path. The agent has a shell and a
 *   Python kernel; it reads the file itself. Base64-ing a 200KB source file into
 *   the prompt would spend context to no purpose, and the RPC's image field only
 *   carries images anyway.
 *
 * The path half deliberately reads like `referenceFooter` in `mentions.ts`,
 * which has done the same job for `@mentions` since before this existed. Two
 * conventions for "here is a file, go read it" would be one too many.
 *
 * All of this is pure string and list work, deliberately: it is the part that is
 * easy to get subtly wrong and cheap to test.
 */

export type AttachmentKind = "image" | "file";

export interface Attachment {
  /** Absolute path on disk. The identity of an attachment — see `addAll`. */
  path: string;
  /** Basename, for the pill. */
  name: string;
  kind: AttachmentKind;
  /** Bytes on disk, for the cap and for showing size on a file pill. */
  size: number;
  /**
   * Base64 payload, images only, filled in at send time rather than at attach
   * time. Attaching should feel instant, and a big screenshot takes a moment
   * to read and downscale.
   */
  data?: string;
  /** `image/png` and friends, images only. */
  mimeType?: string;
}

/**
 * What the model can actually be shown.
 *
 * Deliberately narrow: these are the formats prime-agent's own image path
 * accepts. A `.tiff` is a real image and still belongs on the path route,
 * because sending it would fail further down where the error is worse.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Bigger than this and it is not a chat attachment, it is a data transfer. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** More than this in one message and the message is not the point any more. */
export const MAX_ATTACHMENTS = 10;

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension: `.env` has none.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

export function kindOf(path: string): AttachmentKind {
  return IMAGE_EXTENSIONS.has(extensionOf(path)) ? "image" : "file";
}

export interface RejectedAttachment {
  path: string;
  reason: string;
}

export interface AddResult {
  attachments: Attachment[];
  /** Said out loud rather than dropped. A file that silently fails to attach
   *  looks like a broken drop target. */
  rejected: RejectedAttachment[];
}

/**
 * Add paths to a list, keeping it sane.
 *
 * Identity is the path: dropping the same file twice, or dropping a file that
 * is already attached, is a no-op rather than a duplicate. The alternative —
 * two identical pills — reads as a bug every time.
 */
export function addAll(
  existing: Attachment[],
  incoming: Array<{ path: string; size: number }>,
): AddResult {
  const attachments = [...existing];
  const rejected: RejectedAttachment[] = [];
  const have = new Set(existing.map((a) => a.path));

  for (const { path, size } of incoming) {
    if (have.has(path)) continue;
    if (size > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        path,
        reason: `${formatBytes(size)} is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`,
      });
      continue;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      rejected.push({ path, reason: `only ${MAX_ATTACHMENTS} attachments at a time` });
      continue;
    }
    have.add(path);
    attachments.push({ path, name: basename(path), kind: kindOf(path), size });
  }
  return { attachments, rejected };
}

export function removeAt(attachments: Attachment[], path: string): Attachment[] {
  return attachments.filter((a) => a.path !== path);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The block appended to a message naming the non-image attachments.
 *
 * Images are absent on purpose: they arrive as bytes the model can see, and a
 * line saying "read /tmp/shot.png" would send the agent off to open a file it
 * has already been shown.
 */
export function attachmentFooter(attachments: Attachment[]): string {
  const files = attachments.filter((a) => a.kind === "file");
  if (files.length === 0) return "";
  return [
    files.length === 1
      ? "The user attached this file. Read it before answering:"
      : "The user attached these files. Read them before answering:",
    ...files.map((a) => `- ${a.path}`),
  ].join("\n");
}

/** Whether a send needs a model that can accept images. */
export function hasImages(attachments: Attachment[]): boolean {
  return attachments.some((a) => a.kind === "image");
}

/**
 * The `images` array for the RPC, in prime-agent's `ImageContent` shape.
 *
 * Anything whose bytes failed to load is left out rather than sent empty: a
 * half-formed image block is a request the provider rejects, which would take
 * the whole turn down with it instead of just the picture.
 */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export function imagePayload(attachments: Attachment[]): ImageContent[] {
  return attachments
    .filter((a) => a.kind === "image" && a.data && a.mimeType)
    .map((a) => ({ type: "image" as const, data: a.data!, mimeType: a.mimeType! }));
}

/**
 * A one-line summary for the composer and for a queued row.
 *
 * Names the file when there is one, counts them when there are several — a row
 * of pills in a queue item would crowd out the prompt it belongs to.
 */
export function summarize(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) return attachments[0].name;
  const images = attachments.filter((a) => a.kind === "image").length;
  const files = attachments.length - images;
  const parts: string[] = [];
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.join(", ");
}
