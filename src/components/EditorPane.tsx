import { useCallback, useEffect, useState } from "react";
import { frontmatterField } from "../research/frontmatter";
import { PdfView } from "../research/PdfView";
import { SelectionBubble } from "../editor/SelectionBubble";
import { useEditorSession } from "../editor/useEditorSession";
import { useLayout } from "../store/layout";
import { MarkdownPreview } from "./MarkdownPreview";
import { saveBuffer, useWorkspace } from "../store/workspace";
import { ipc } from "../ipc/client";
import { editorRegistry } from "../editor/editorRegistry";

function ConflictBanner({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const resolveReloaded = useWorkspace((s) => s.resolveBufferReloaded);

  const takeTheirs = async () => {
    const fresh = await ipc.fileRead(workspaceId, relPath);
    const session = editorRegistry.get(relPath);
    if (session) {
      editorRegistry.delete(relPath); // force rebuild from disk
    }
    resolveReloaded(relPath, fresh.contentHash);
    // Re-open to rebuild the view with fresh content.
    useWorkspace.getState().closeFile(relPath);
    useWorkspace.getState().openFile(relPath);
  };

  const keepMine = async () => {
    const stat = await ipc.fileStat(workspaceId, relPath);
    // Adopt the current disk hash as the expected base, then save over it.
    if (stat.contentHash) editorRegistry.updateDiskHash(relPath, stat.contentHash);
    useWorkspace.getState().markSaved(relPath, stat.contentHash ?? "");
    useWorkspace.getState().markDirty(relPath);
  };

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "8px 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--raised)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span aria-hidden style={{ color: "var(--error)" }}>
        ⚠
      </span>
      <span style={{ color: "var(--ink-secondary)" }}>
        Changed on disk while you had unsaved edits.
      </span>
      <button className="btn" onClick={takeTheirs}>
        Take disk version
      </button>
      <button className="btn" onClick={keepMine}>
        Keep mine (overwrite on save)
      </button>
    </div>
  );
}

function isMd(p: string): boolean {
  const l = p.toLowerCase();
  return l.endsWith(".md") || l.endsWith(".markdown");
}

export function EditorPane() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useLayout((s) => s.activeFile());
  const phase = useWorkspace((s) => (active ? s.buffers[active]?.phase : undefined));
  const preview = useLayout((s) => (active ? (s.mdPreview[active] ?? false) : false));
  const togglePreview = useLayout((s) => s.toggleMdPreview);

  // A paper note names its PDF in frontmatter. Without this the file sits on
  // disk with nothing anywhere that opens it — the note was the only way in.
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [showPdf, setShowPdf] = useState(false);
  useEffect(() => {
    setShowPdf(false);
    setPdfPath(null);
    if (!workspace || !active || !/\.(md|markdown)$/i.test(active)) return;
    let live = true;
    void ipc
      .fileRead(workspace.id, active)
      .then((c) => live && setPdfPath(frontmatterField(c.text, "pdf")))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspace?.id, active]);

  if (!workspace || !active) return null;
  // A PDF is not text; opening one in the editor would show its raw bytes.
  if (/\.pdf$/i.test(active)) {
    return <PdfView workspaceId={workspace.id} relPath={active} />;
  }
  const markdown = isMd(active);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {phase === "conflict" && <ConflictBanner workspaceId={workspace.id} relPath={active} />}
      {markdown && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--s-3)",
            padding: "var(--s-2) var(--s-3)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {pdfPath && (
            <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Paper view">
              {([false, true] as const).map((wantPdf) => (
                <button
                  key={String(wantPdf)}
                  className="btn"
                  aria-pressed={showPdf === wantPdf}
                  onClick={() => setShowPdf(wantPdf)}
                  style={{
                    fontSize: "var(--text-xs)",
                    padding: "3px 10px",
                    background: showPdf === wantPdf ? "var(--raised)" : "transparent",
                    borderColor: showPdf === wantPdf ? "var(--border)" : "transparent",
                    color: showPdf === wantPdf ? "var(--ink)" : "var(--ink-muted)",
                  }}
                >
                  {wantPdf ? "PDF" : "Note"}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Markdown view">
            {(["source", "preview"] as const).map((m) => {
              const on = (m === "preview") === preview;
              return (
                <button
                  key={m}
                  className="btn"
                  aria-pressed={on}
                  onClick={() => {
                    if ((m === "preview") !== preview) togglePreview(active);
                  }}
                  style={{
                    fontSize: "var(--text-xs)",
                    padding: "3px 10px",
                    textTransform: "capitalize",
                    background: on ? "var(--raised)" : "transparent",
                    borderColor: on ? "var(--border)" : "transparent",
                    color: on ? "var(--ink)" : "var(--ink-muted)",
                  }}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {markdown && showPdf && pdfPath ? (
        <PdfView workspaceId={workspace.id} relPath={pdfPath} />
      ) : markdown && preview ? (
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <MarkdownPreview workspaceId={workspace.id} relPath={active} />
        </div>
      ) : (
        <Editor key={active} workspaceId={workspace.id} relPath={active} />
      )}
    </div>
  );
}


function Editor({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const { mount, viewRef } = useEditorSession(workspaceId, relPath);
  // Cmd+S is bound inside the editor; this button is the visible affordance.
  const phase = useWorkspace((s) => s.buffers[relPath]?.phase);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // A stable ref callback. An inline arrow is a NEW function every render, so
  // React tears the old one down and calls this again — and `mount` builds a
  // fresh EditorView each time it is handed a node, which rebuilt the editor
  // mid-typing (this component re-renders whenever the buffer turns dirty).
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      setHost(node);
      mount(node);
    },
    [mount],
  );
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <div ref={attach} style={{ height: "100%", overflow: "hidden" }} />
      <SelectionBubble viewRef={viewRef} relPath={relPath} host={host} />
      {phase === "dirty" && (
        <button
          className="btn"
          style={{ position: "absolute", right: 16, bottom: 16, fontSize: "var(--text-xs)", boxShadow: "var(--lift)", background: "var(--canvas)" }}
          onClick={() => {
            const v = viewRef.current;
            if (v) void saveBuffer(relPath, () => v.state.doc.toString());
          }}
        >
          Save ⌘S
        </button>
      )}
    </div>
  );
}
