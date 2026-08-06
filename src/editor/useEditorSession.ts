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
import { useLinks } from "../store/links";
import { saveBuffer, useWorkspace } from "../store/workspace";

const MAX_EXCERPT = 90;

function excerpt(text: string): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
}

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
        if (u.selectionSet || u.docChanged) {
          // Selection drives link creation. Only the summary reaches the store —
          // mirroring selection text into React on every keystroke is the
          // re-render trap this architecture avoids.
          const range = u.state.selection.main;
          useLinks.getState().setSelection(
            range.empty
              ? null
              : {
                  relPath,
                  from: range.from,
                  to: range.to,
                  excerpt: excerpt(u.state.sliceDoc(range.from, range.to)),
                },
          );
        }
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

        // Cross-mode navigation: a link click parked a range for this file.
        const reveal = useWorkspace.getState().consumeReveal(relPath);
        if (reveal && view) {
          const max = view.state.doc.length;
          const from = Math.min(reveal.from, max);
          const to = Math.min(reveal.to, max);
          view.dispatch({
            selection: { anchor: from, head: to },
            effects: EditorView.scrollIntoView(from, { y: "center" }),
          });
          view.focus();
        }
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

  // Reveal requests for a file that is ALREADY mounted (no remount to hook).
  useEffect(() => {
    return useWorkspace.subscribe((state) => {
      const pending = state.pendingReveal;
      const view = viewRef.current;
      if (!pending || pending.relPath !== relPath || !view) return;
      useWorkspace.getState().consumeReveal(relPath);
      const max = view.state.doc.length;
      const from = Math.min(pending.from, max);
      const to = Math.min(pending.to, max);
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      view.focus();
    });
  }, [relPath]);

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
