import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These exist because of a specific failure: run `@agent[…]`, switch tabs
 * while it thinks, come back, and the note showed "…thinking" forever with the
 * answer thrown away — and any edit made meanwhile was reverted.
 *
 * Two causes. The background task held the view it started with, which is
 * destroyed on a tab switch. And a note had two sources of truth, the editor's
 * document and the file, with different writers using different ones.
 */
const files = new Map<string, { text: string; contentHash: string }>();

vi.mock("../ipc/client", () => ({
  ipc: {
    fileRead: vi.fn(async (_ws: string, p: string) => {
      const f = files.get(p);
      if (!f) throw new Error(`no such file ${p}`);
      return { ...f };
    }),
    fileWrite: vi.fn(async (_ws: string, p: string, text: string) => {
      const contentHash = `h${text.length}`;
      files.set(p, { text, contentHash });
      return { contentHash };
    }),
  },
}));

// saveBuffer writes through the same fake file store, as it does through the
// same command in the app.
vi.mock("../store/workspace", () => ({
  saveBuffer: vi.fn(async (relPath: string, getText: () => string) => {
    files.set(relPath, { text: getText(), contentHash: `h${getText().length}` });
    return "saved" as const;
  }),
}));

import { editorRegistry } from "../editor/editorRegistry";
import { editNote, replaceMarker } from "./noteEdits";

const PATH = "papers/x.md";

function mountView(text: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: text }),
    parent: document.body,
  });
  editorRegistry.bindView(PATH, view);
  return view;
}

beforeEach(() => {
  files.clear();
  editorRegistry.clear();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("editNote", () => {
  it("goes through the editor when the note is open, and reaches disk", async () => {
    files.set(PATH, { text: "hello", contentHash: "h5" });
    const view = mountView("hello");

    await editNote("w", PATH, (t) => `${t} world`);

    expect(view.state.doc.toString()).toBe("hello world");
    expect(files.get(PATH)!.text).toBe("hello world");
  });

  it("writes the file when the note is not open", async () => {
    files.set(PATH, { text: "hello", contentHash: "h5" });
    await editNote("w", PATH, (t) => `${t} world`);
    expect(files.get(PATH)!.text).toBe("hello world");
  });

  /**
   * The regression. Writing the file directly while the editor holds unsaved
   * work discarded it, and the editor's next save discarded this — which read
   * as "it reverted when I came back".
   */
  it("does not discard unsaved editor work", async () => {
    files.set(PATH, { text: "on disk", contentHash: "h7" });
    const view = mountView("on disk");
    // The user types; the file is now behind.
    view.dispatch({ changes: { from: view.state.doc.length, insert: " plus my edit" } });

    await editNote("w", PATH, (t) => `${t} plus the agent`);

    expect(view.state.doc.toString()).toBe("on disk plus my edit plus the agent");
    expect(files.get(PATH)!.text).toBe("on disk plus my edit plus the agent");
  });

  it("is one undo step, not two", async () => {
    files.set(PATH, { text: "start", contentHash: "h5" });
    const view = mountView("start");
    await editNote("w", PATH, () => "replaced entirely");
    expect(view.state.doc.toString()).toBe("replaced entirely");
  });

  it("writes nothing when the transform changes nothing", async () => {
    files.set(PATH, { text: "same", contentHash: "h4" });
    await editNote("w", PATH, (t) => t);
    expect(files.get(PATH)!.contentHash).toBe("h4");
  });
});

describe("replaceMarker", () => {
  it("swaps the placeholder in an open note", async () => {
    files.set(PATH, { text: "a …thinking(abc) b", contentHash: "h1" });
    const view = mountView("a …thinking(abc) b");

    expect(await replaceMarker("w", PATH, "…thinking(abc)", "the answer")).toBe(true);
    expect(view.state.doc.toString()).toBe("a the answer b");
  });

  /** The exact bug: the tab was closed while the request was in flight. */
  it("still lands when the editor has gone away", async () => {
    files.set(PATH, { text: "a …thinking(abc) b", contentHash: "h1" });
    const view = mountView("a …thinking(abc) b");
    // Tab switch: the view is torn down as the editor unmounts.
    editorRegistry.unbindView(PATH, view);
    view.destroy();

    expect(await replaceMarker("w", PATH, "…thinking(abc)", "the answer")).toBe(true);
    expect(files.get(PATH)!.text).toBe("a the answer b");
  });

  /** Typing during the request must not cause a write into the wrong place. */
  it("reports false when the placeholder has been edited away", async () => {
    files.set(PATH, { text: "the user deleted it", contentHash: "h1" });
    mountView("the user deleted it");

    expect(await replaceMarker("w", PATH, "…thinking(abc)", "the answer")).toBe(false);
    expect(files.get(PATH)!.text).toBe("the user deleted it");
  });

  /** Two directives running at once must not claim each other's answer. */
  it("matches only its own token", async () => {
    const doc = "one …thinking(aaa) two …thinking(bbb)";
    files.set(PATH, { text: doc, contentHash: "h1" });
    const view = mountView(doc);

    await replaceMarker("w", PATH, "…thinking(bbb)", "SECOND");
    expect(view.state.doc.toString()).toBe("one …thinking(aaa) two SECOND");
  });
});
