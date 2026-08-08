import { FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes, type Attachment } from "../chat/attachments";
import { thumbnail } from "../chat/loadImages";
import { useComposer } from "../store/composer";

/**
 * What is attached, above the input.
 *
 * Above rather than inline because the order of events is: attach the thing,
 * then say what you want done with it. A pill that pushed the caret around, or
 * sent on drop, would get in the way of the sentence you are still writing.
 *
 * Images show a thumbnail. A filename is not a picture, and after two
 * screenshots you cannot tell `Screenshot 2026-08-08 at 12.34.38.png` from
 * `Screenshot 2026-08-08 at 12.35.02.png` — which is precisely when you are
 * most likely to send the wrong one.
 */
function Pill({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.kind !== "image") return;
    let live = true;
    void thumbnail(attachment.path).then((src) => {
      if (live) setThumb(src);
    });
    return () => {
      live = false;
    };
  }, [attachment.path, attachment.kind]);

  return (
    <span
      className="chip"
      title={`${attachment.path} · ${formatBytes(attachment.size)}`}
      style={{ paddingLeft: attachment.kind === "image" ? 3 : undefined, maxWidth: 220 }}
    >
      {attachment.kind === "image" ? (
        thumb ? (
          <img
            src={thumb}
            alt=""
            style={{ width: 18, height: 18, objectFit: "cover", borderRadius: 3, flexShrink: 0 }}
          />
        ) : (
          <span style={{ width: 18, height: 18, background: "var(--raised)", borderRadius: 3 }} />
        )
      ) : (
        <FileText size={11} strokeWidth={1.8} style={{ flexShrink: 0 }} />
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {attachment.name}
      </span>
      <button className="chip-x" aria-label={`Remove ${attachment.name}`} onClick={onRemove}>
        <X size={10} strokeWidth={2.2} />
      </button>
    </span>
  );
}

export function AttachmentStrip() {
  const attachments = useComposer((s) => s.attachments);
  const rejected = useComposer((s) => s.rejected);
  const detach = useComposer((s) => s.detach);
  const dismissRejected = useComposer((s) => s.dismissRejected);

  if (attachments.length === 0 && rejected.length === 0) return null;

  return (
    <div className="composer-meta" style={{ display: "block" }}>
      {rejected.length > 0 && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "var(--s-2)",
            color: "var(--error)",
            padding: "0 2px 3px",
          }}
        >
          <span style={{ flex: 1 }}>{rejected.join(" · ")}</span>
          <button
            className="btn small"
            onClick={dismissRejected}
            style={{ borderColor: "transparent", color: "var(--ink-faint)" }}
          >
            Dismiss
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)", padding: "0 2px 2px" }}>
          {attachments.map((a) => (
            <Pill key={a.path} attachment={a} onRemove={() => detach(a.path)} />
          ))}
        </div>
      )}
    </div>
  );
}
