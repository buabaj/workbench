import { useCallback, useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorRegistry } from "./editorRegistry";
import { applyLanguage, codeExtensions, markdownExtras } from "./extensions";
import { formatError, ipc, onFsChanged } from "../ipc/client";
import { directiveAt } from "../research/agentDirective";
import { replaceMarker } from "../research/noteEdits";
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
/**
 * Select a revealed range and scroll it into view.
 *
 * A line-based reveal (from search) is resolved against the document here,
 * because only the view knows where a line starts. Everything is clamped: the
 * file may have changed since the range was recorded, and a stale offset must
 * land somewhere valid rather than throw.
 */
function applyReveal(
  view: EditorView,
  reveal: { from: number; to: number; line?: number },
): void {
  const doc = view.state.doc;
  let from: number;
  let to: number;
  if (reveal.line != null) {
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    from = Math.min(line.from + reveal.from, line.to);
    to = Math.min(line.from + reveal.to, line.to);
  } else {
    from = Math.min(reveal.from, doc.length);
    to = Math.min(reveal.to, doc.length);
  }
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: "center" }),
  });
  view.focus();
}

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
      /**
       * ⌘↵ runs the nearest `@agent[...]` and replaces it with the answer.
       *
       * Through a CodeMirror transaction rather than rewriting the file, so
       * the change is undoable with ⌘Z like anything else you typed — an edit
       * you cannot take back is not one people will risk.
       */
      /**
       * Returns whether a directive was found, synchronously, so the caller
       * knows whether to consume the keystroke. The work continues after.
       */
      const runDirective = (view: EditorView): boolean => {
        const text = view.state.doc.toString();
        const d = directiveAt(text, view.state.selection.main.head);
        if (!d) {
          // Say so. A keystroke that does nothing is indistinguishable from a
          // broken one, and this binding has now been reported dead twice when
          // it was working and finding nothing to run.
          useWorkspace.getState().notify?.(
            "No @agent[…] found — write one, and check an earlier bracket is closed.",
          );
          return false; // and let ⌘↵ do its ordinary thing
        }
        void execute(view, text, d);
        return true;
      };

      /**
       * Run a directive and put the answer where it stood.
       *
       * Nothing here holds the view across the await. The placeholder is
       * written and SAVED first, so it exists on disk as well as in the
       * editor; when the answer arrives it is matched by text through
       * `replaceMarker`, which finds whichever view is current or falls back
       * to the file. Capturing the view meant a tab switch left the note
       * showing "…thinking" forever with the result thrown away.
       */
      const execute = async (
        view: EditorView,
        text: string,
        d: { instruction: string; start: number; end: number },
      ) => {
        // Unique per run, so two directives in flight cannot claim each
        // other's answer.
        const token = `…thinking(${Math.random().toString(36).slice(2, 8)})`;
        view.dispatch({ changes: { from: d.start, to: d.end, insert: token } });
        await saveBuffer(relPath, () => view.state.doc.toString()).catch(() => {});

        try {
          const out = await ipc.noteAction(workspaceId, d.instruction, text);
          await replaceMarker(workspaceId, relPath, token, out.text.trim());
        } catch (e) {
          await replaceMarker(
            workspaceId,
            relPath,
            token,
            `@agent[${d.instruction}]\n\n> agent failed: ${formatError(e)}`,
          ).catch(() => {});
        }
      };

      const saveKeymap = EditorView.domEventHandlers({
        keydown: (event, v) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            // `v`, the view the event came from — not the closure variable,
            // which is a different binding and null until the view is built.
            // And preventDefault, or ⌘↵ inserts a newline as well as running.
            if (/\.(md|markdown)$/i.test(relPath) && runDirective(v)) {
              event.preventDefault();
              return true;
            }
          }
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
              // Markdown opens as source: it IS code, and prose styling made
              // files unreadable as files. Rendered output lives behind the
              // preview toggle instead.
              codeExtensions(),
              // `[[` completion is for prose. In code a double bracket is an
              // array index, and a popup there would be an interruption.
              ...(/\.(md|markdown)$/i.test(relPath) ? markdownExtras : []),
              dirtyListener,
              // Highest precedence, deliberately. CodeMirror's defaultKeymap
              // already binds Mod-Enter to insertBlankLine, and it is provided
              // first — so without this our handler never sees ⌘↵ at all, and
              // the keystroke silently inserts a blank line instead. ⌘S worked
              // throughout only because nothing else claims Mod-s.
              Prec.highest(saveKeymap),
            ],
          });
        view = new EditorView({ state, parent: node });
        viewRef.current = view;
        // Reachable by path, so a background task can find the CURRENT view
        // when it finishes rather than the one it started with.
        editorRegistry.bindView(relPath, view);
        if (saved) {
          view.scrollDOM.scrollTop = saved.scrollTop;
        } else {
          editorRegistry.set(relPath, { state, scrollTop: 0, diskHash });
          useWorkspace.getState().markSaved(relPath, diskHash);
        }
        void applyLanguage(view, relPath);

        // Cross-mode navigation: a link click parked a range for this file.
        const reveal = useWorkspace.getState().consumeReveal(relPath);
        if (reveal && view) applyReveal(view, reveal);
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
          editorRegistry.unbindView(relPath, view);
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
      applyReveal(view, pending);
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
