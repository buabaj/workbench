import { useEffect, useState } from "react";
import { Markdown } from "./Markdown";
import { ipc } from "../ipc/client";
import { editorRegistry } from "../editor/editorRegistry";

/**
 * Rendered view of a Markdown file.
 *
 * Raw HTML in the source is escaped rather than passed through: a note can come
 * from anywhere — an agent wrote it, a repo shipped it — and the webview shares
 * an origin with the IPC bridge. Escaping removes the injection surface without
 * needing a sanitiser dependency.
 */
export function MarkdownPreview({
  workspaceId,
  relPath,
}: {
  workspaceId: string;
  relPath: string;
}) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    // Prefer the live buffer so preview reflects unsaved edits.
    const session = editorRegistry.get(relPath);
    if (session) {
      setSource(session.state.doc.toString());
      return;
    }
    void ipc
      .fileRead(workspaceId, relPath)
      .then((c) => setSource(c.text))
      .catch(() => setSource(null));
  }, [workspaceId, relPath]);

  if (source === null) {
    return <div style={{ padding: "var(--s-6)", color: "var(--ink-faint)" }}>Loading…</div>;
  }

  return <Markdown source={source} className="md md-preview" />;
}
