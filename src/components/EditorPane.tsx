import { useEditorSession } from "../editor/useEditorSession";
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
        borderBottom: "1px solid var(--structure-strong)",
        background: "var(--surface-raised)",
        fontSize: 11,
      }}
    >
      <span aria-hidden style={{ color: "var(--danger)" }}>
        ⚠
      </span>
      <span style={{ color: "var(--ink-muted)" }}>
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

export function EditorPane() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useWorkspace((s) => s.active);
  const phase = useWorkspace((s) => (active ? s.buffers[active]?.phase : undefined));

  if (!workspace || !active) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {phase === "conflict" && <ConflictBanner workspaceId={workspace.id} relPath={active} />}
      <Tabs />
      <Editor key={active} workspaceId={workspace.id} relPath={active} />
    </div>
  );
}

function Tabs() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.active);
  const buffers = useWorkspace((s) => s.buffers);
  const setActive = useWorkspace((s) => s.setActive);
  const closeFile = useWorkspace((s) => s.closeFile);

  if (tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Open files"
      style={{
        display: "flex",
        gap: 2,
        padding: "6px 12px 0",
        borderBottom: "1px solid var(--structure)",
        overflowX: "auto",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const name = t.split("/").pop();
        const phase = buffers[t]?.phase;
        return (
          <div
            key={t}
            role="tab"
            aria-selected={t === active}
            aria-label={`${name}${phase === "dirty" ? ", unsaved" : ""}`}
            tabIndex={0}
            onClick={() => setActive(t)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActive(t);
              } else if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                closeFile(t);
              }
            }}
            style={{
              display: "flex",
              gap: 7,
              alignItems: "center",
              padding: "5px 10px",
              fontSize: 11,
              color: t === active ? "var(--ink)" : "var(--ink-muted)",
              background: t === active ? "var(--surface-raised)" : "transparent",
              borderRadius: "var(--r) var(--r) 0 0",
              borderBottom: t === active ? "2px solid var(--accent)" : "2px solid transparent",
              whiteSpace: "nowrap",
            }}
          >
            {name}
            {phase === "dirty" && (
              <span aria-hidden style={{ color: "var(--accent)", fontSize: 9 }}>
                ●
              </span>
            )}
            <button
              aria-label={`Close ${name}`}
              style={{
                color: "var(--ink-faint)",
                fontSize: 10,
                background: "none",
                border: "none",
                font: "inherit",
                padding: 0,
              }}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(t);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
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
          style={{ position: "absolute", right: 14, bottom: 12, fontSize: 10 }}
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
