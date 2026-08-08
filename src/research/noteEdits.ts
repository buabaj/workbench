import { editorRegistry } from "../editor/editorRegistry";
import { ipc } from "../ipc/client";
import { saveBuffer } from "../store/workspace";

/**
 * The one way anything other than typing changes a note.
 *
 * There were two sources of truth for an open note: CodeMirror's document, and
 * the file. `@agent[…]` edited the document; annotations and the provenance
 * bar read and wrote the file. With unsaved changes in the editor those two
 * disagree, and whichever wrote last silently discarded the other's work —
 * which is what made edits appear to revert on returning to a tab.
 *
 * So: if the note is open, the editor's document is authoritative and the
 * change goes through it, then to disk. If it is not open, the file is
 * authoritative. Never both.
 */

/** Apply a whole-document transform to a note, open or not. */
export async function editNote(
  workspaceId: string,
  relPath: string,
  transform: (text: string) => string,
): Promise<void> {
  const view = editorRegistry.liveView(relPath);

  if (view) {
    const before = view.state.doc.toString();
    const after = transform(before);
    if (after === before) return;
    // One transaction over the whole document, so it is a single undo step
    // rather than a replace the user has to undo twice.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: after } });
    // Straight to disk: leaving it dirty is what let a later file-read see
    // stale content and reintroduce the disagreement.
    await saveBuffer(relPath, () => after);
    return;
  }

  const current = await ipc.fileRead(workspaceId, relPath);
  const after = transform(current.text);
  if (after === current.text) return;
  await ipc.fileWrite(workspaceId, relPath, after, current.contentHash);
}

/**
 * Replace one span of a note, addressed by the text that is there now.
 *
 * Used for swapping a placeholder for a result. Finding the marker at write
 * time rather than trusting an offset recorded before an await is deliberate:
 * the document may have been typed into while the request was in flight, and
 * an offset from before would land in the middle of a sentence.
 *
 * Returns false when the marker has gone — the note was edited or reverted
 * underneath, and writing anywhere would be a guess.
 */
export async function replaceMarker(
  workspaceId: string,
  relPath: string,
  marker: string,
  replacement: string,
): Promise<boolean> {
  let replaced = false;
  await editNote(workspaceId, relPath, (text) => {
    const at = text.indexOf(marker);
    if (at === -1) return text;
    replaced = true;
    return text.slice(0, at) + replacement + text.slice(at + marker.length);
  });
  return replaced;
}
