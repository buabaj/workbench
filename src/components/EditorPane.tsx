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

  if (!workspace || !active) return null;
  const markdown = isMd(active);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {phase === "conflict" && <ConflictBanner workspaceId={workspace.id} relPath={active} />}
      {markdown && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "var(--s-2) var(--s-3)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
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
      {markdown && preview ? (
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
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <div ref={mount} style={{ height: "100%", overflow: "hidden" }} />
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
