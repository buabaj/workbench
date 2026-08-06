import { useCallback, useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorRegistry } from "./editorRegistry";
import {
  applyLanguage,
  codeExtensions,
  isResearchFile,
  researchExtensions,
} from "./extensions";
import { ipc, onFsChanged } from "../ipc/client";
import { saveBuffer, useWorkspace } from "../store/workspace";

/**
 * Owns one CodeMirror view for one file. The authoritative EditorState lives in
 * the module-level registry, so StrictMode double-mounts and tab switches
 * restore exactly (undo history, selection, scroll included).
 */
export function useEditorSession(workspaceId: string, relPath: string) {
  const viewRef = useRef<EditorView | null>(null);

  const mount = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      let disposed = false;
      let view: EditorView | null = null;

      const dirtyListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) useWorkspace.getState().markDirty(relPath);
      });
      const saveKeymap = EditorView.domEventHandlers({
        keydown: (event, v) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void saveBuffer(relPath, () => v.state.doc.toString());
            return true;
          }
          return false;
        },
      });

      const build = (text: string, diskHash: string) => {
        if (disposed) return;
        const saved = editorRegistry.get(relPath);
        const state =
          saved?.state ??
          EditorState.create({
            doc: text,
            extensions: [
              isResearchFile(relPath) ? researchExtensions() : codeExtensions(),
              dirtyListener,
              saveKeymap,
            ],
          });
        view = new EditorView({ state, parent: node });
        viewRef.current = view;
        if (saved) {
          view.scrollDOM.scrollTop = saved.scrollTop;
        } else {
          editorRegistry.set(relPath, { state, scrollTop: 0, diskHash });
          useWorkspace.getState().markSaved(relPath, diskHash);
        }
        if (!isResearchFile(relPath)) void applyLanguage(view, relPath);
      };

      const saved = editorRegistry.get(relPath);
      if (saved) {
        build("", saved.diskHash);
      } else {
        void ipc
          .fileRead(workspaceId, relPath)
          .then((c) => build(c.text, c.contentHash))
          .catch(() => {
            /* surfaced via buffer phase elsewhere */
          });
      }

      return () => {
        disposed = true;
        if (view) {
          editorRegistry.set(relPath, {
            state: view.state,
            scrollTop: view.scrollDOM.scrollTop,
            diskHash: editorRegistry.get(relPath)?.diskHash ?? "",
          });
          view.destroy();
        }
        viewRef.current = null;
      };
    },
    [workspaceId, relPath],
  );

  // External-change policy: clean buffer → silent reload preserving cursor;
  // dirty buffer whose disk hash moved → conflict.
  useEffect(() => {
    const un = onFsChanged(async (e) => {
      if (e.workspaceId !== workspaceId) return;
      if (!e.paths.includes(relPath) && !e.overflow) return;
      const view = viewRef.current;
      const session = editorRegistry.get(relPath);
      if (!view || !session) return;

      const stat = await ipc.fileStat(workspaceId, relPath).catch(() => null);
      if (!stat) return;
      if (!stat.exists) {
        useWorkspace.getState().markConflict(relPath);
        return;
      }
      if (stat.contentHash === session.diskHash) return; // our own write echo

      const phase = useWorkspace.getState().buffers[relPath]?.phase ?? "clean";
      if (phase === "dirty" || phase === "conflict") {
        useWorkspace.getState().markConflict(relPath);
        return;
      }
      // Clean: reload as a transaction so cursor/scroll survive.
      const fresh = await ipc.fileRead(workspaceId, relPath).catch(() => null);
      if (!fresh) return;
      const cur = view.state.doc.toString();
      if (cur === fresh.text) {
        editorRegistry.updateDiskHash(relPath, fresh.contentHash);
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: fresh.text },
      });
      editorRegistry.updateDiskHash(relPath, fresh.contentHash);
      useWorkspace.getState().resolveBufferReloaded(relPath, fresh.contentHash);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [workspaceId, relPath]);

  return { mount, viewRef };
}
