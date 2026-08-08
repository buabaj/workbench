import { create } from "zustand";
import { buildTreeStatus, NO_CHANGES, type TreeStatus } from "../vcs/treeStatus";
import {
  ipc,
  isConflict,
  type FsChanged,
  type PreflightReport,
  type TreeNode,
  type WorkspaceView,
} from "../ipc/client";
import { editorRegistry } from "../editor/editorRegistry";
import { fileTabId, useLayout } from "./layout";

export type BufferPhase = "clean" | "dirty" | "conflict" | "deleted";

export interface BufferMeta {
  relPath: string;
  phase: BufferPhase;
  diskHash: string;
}

interface WorkspaceStore {
  workspace: WorkspaceView | null;
  preflight: PreflightReport | null;
  mode: "code" | "research";
  childrenByPath: Record<string, TreeNode[]>;
  expanded: Record<string, boolean>;
  /** Folder last opened in the tree; new files land here. "" is the root. */
  selectedDir: string;
  buffers: Record<string, BufferMeta>;
  /** Range an editor should scroll to and select once mounted (cross-mode nav). */
  /**
   * A range to select once the file is on screen.
   *
   * `from`/`to` are document offsets, except when `line` is set — then they are
   * columns within that 1-indexed line, which is what a search result knows.
   * Resolving that needs the document, so it happens in the editor.
   */
  pendingReveal: { relPath: string; from: number; to: number; line?: number } | null;

  setMode(mode: "code" | "research"): void;
  pickWorkspace(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  loadChildren(subpath: string): Promise<void>;
  collapseAll(): void;
  /** Transient one-line message, for actions with no visible result. */
  notice: string | null;
  notify(message: string): void;
  /** Git state arranged for the tree; refreshed with the file watcher. */
  gitStatus: TreeStatus;
  refreshGitStatus(): Promise<void>;
  /** Open every folder down to a path, so the tree shows where it lives. */
  revealInTree(relPath: string): Promise<void>;
  selectDir(relPath: string): void;
  toggleDir(relPath: string): void;
  openFile(relPath: string): void;
  revealRange(relPath: string, from: number, to: number): void;
  consumeReveal(relPath: string): { from: number; to: number; line?: number } | null;
  revealLine(relPath: string, line: number, colFrom: number, colTo: number): void;
  closeFile(relPath: string): void;
  markDirty(relPath: string): void;
  markSaved(relPath: string, diskHash: string): void;
  markConflict(relPath: string): void;
  resolveBufferReloaded(relPath: string, diskHash: string): void;
  refreshPreflight(): Promise<void>;
  handleFsChanged(e: FsChanged): void;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  workspace: null,
  preflight: null,
  mode: "research",
  childrenByPath: {},
  expanded: {},
  selectedDir: "",
  buffers: {},
  pendingReveal: null,

  setMode: (mode) => set({ mode }),

  pickWorkspace: async () => {
    const ws = await ipc.workspacePick();
    if (ws) {
      editorRegistry.clear();
      set({
        workspace: ws,
        childrenByPath: {},
        expanded: {},
        buffers: {},
        selectedDir: "",
        gitStatus: NO_CHANGES,
      });
      await useLayout.getState().hydrate(ws.id);
      await get().loadChildren("");
      void get().refreshGitStatus();
    }
  },

  openWorkspace: async (path) => {
    const ws = await ipc.workspaceOpen(path);
    editorRegistry.clear();
    set({
      workspace: ws,
      childrenByPath: {},
      expanded: {},
      buffers: {},
      selectedDir: "",
      gitStatus: NO_CHANGES,
    });
    await useLayout.getState().hydrate(ws.id);
    await get().loadChildren("");
    void get().refreshGitStatus();
  },

  loadChildren: async (subpath) => {
    const ws = get().workspace;
    if (!ws) return;
    const nodes = await ipc.workspaceTree(ws.id, subpath || undefined);
    set((s) => ({ childrenByPath: { ...s.childrenByPath, [subpath]: nodes } }));
  },

  toggleDir: (relPath) => {
    const { expanded } = get();
    const open = !expanded[relPath];
    set((s) => ({ expanded: { ...s.expanded, [relPath]: open } }));
    if (open && !get().childrenByPath[relPath]) {
      void get().loadChildren(relPath);
    }
  },

  /** Fold every directory shut, leaving the root level visible. */
  collapseAll: () => set({ expanded: {}, selectedDir: "" }),

  gitStatus: NO_CHANGES,

  refreshGitStatus: async () => {
    const { workspace } = get();
    if (!workspace || workspace.kind !== "git") {
      set({ gitStatus: NO_CHANGES });
      return;
    }
    try {
      set({ gitStatus: buildTreeStatus(await ipc.worktreeChanges(workspace.id)) });
    } catch {
      // A tree with no markings is better than a tree with wrong ones.
      set({ gitStatus: NO_CHANGES });
    }
  },

  /**
   * Expand the path to a file, loading each level on the way.
   *
   * The tree is lazy, so an ancestor's children may never have been fetched —
   * marking it expanded without loading them would open an empty folder.
   */
  revealInTree: async (relPath) => {
    const parts = relPath.split("/");
    parts.pop(); // the file itself is not a folder to open
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (!get().childrenByPath[prefix]) await get().loadChildren(prefix);
      set((s) => ({ expanded: { ...s.expanded, [prefix]: true } }));
    }
  },

  notice: null,
  notify: (message) => {
    set({ notice: message });
    window.setTimeout(() => {
      // Only clear if it is still the same message: a newer one must not be
      // cut short by an older one's timer.
      if (useWorkspace.getState().notice === message) set({ notice: null });
    }, 4000);
  },

  selectDir: (relPath) => set({ selectedDir: relPath }),

  openFile: (relPath) => {
    useLayout.getState().openFileTab(relPath);
  },

  revealRange: (relPath, from, to) => {
    // Activating the tab mounts the editor, which consumes the reveal — so
    // navigation works whether the target was open, behind chat, or closed.
    useLayout.getState().openFileTab(relPath);
    set({ pendingReveal: { relPath, from, to } });
  },

  revealLine: (relPath, line, colFrom, colTo) =>
    set({ pendingReveal: { relPath, line, from: colFrom, to: colTo } }),

  consumeReveal: (relPath) => {
    const pending = get().pendingReveal;
    if (!pending || pending.relPath !== relPath) return null;
    set({ pendingReveal: null });
    return { from: pending.from, to: pending.to };
  },

  closeFile: (relPath) => {
    useLayout.getState().closeTab(fileTabId(relPath));
    set((s) => {
      const buffers = { ...s.buffers };
      delete buffers[relPath];
      return { buffers };
    });
  },

  markDirty: (relPath) =>
    set((s) => ({
      buffers: {
        ...s.buffers,
        [relPath]: {
          relPath,
          diskHash: s.buffers[relPath]?.diskHash ?? "",
          phase: s.buffers[relPath]?.phase === "conflict" ? "conflict" : "dirty",
        },
      },
    })),

  markSaved: (relPath, diskHash) =>
    set((s) => ({
      buffers: { ...s.buffers, [relPath]: { relPath, diskHash, phase: "clean" } },
    })),

  markConflict: (relPath) =>
    set((s) => ({
      buffers: {
        ...s.buffers,
        [relPath]: {
          relPath,
          diskHash: s.buffers[relPath]?.diskHash ?? "",
          phase: "conflict",
        },
      },
    })),

  resolveBufferReloaded: (relPath, diskHash) =>
    set((s) => ({
      buffers: { ...s.buffers, [relPath]: { relPath, diskHash, phase: "clean" } },
    })),

  refreshPreflight: async () => {
    const report = await ipc.agentPreflight();
    set({ preflight: report });
  },

  handleFsChanged: (e) => {
    const { workspace, childrenByPath } = get();
    if (!workspace || e.workspaceId !== workspace.id) return;
    // Refresh any loaded directory that contains a changed path.
    const dirs = new Set<string>();
    for (const p of e.paths) {
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      dirs.add(parent);
    }
    for (const dir of dirs) {
      if (childrenByPath[dir] !== undefined) void get().loadChildren(dir);
    }
    if (e.overflow) void get().loadChildren("");
    // Editing a file changes its git state, so the markings follow the same
    // signal the tree does rather than needing their own poll.
    void get().refreshGitStatus();
  },
}));

/** Save the active buffer: reads text from the live editor, writes with the
 * optimistic-concurrency hash, and transitions the buffer phase. */
export async function saveBuffer(
  relPath: string,
  getText: () => string,
): Promise<"saved" | "conflict"> {
  const { workspace, buffers } = useWorkspace.getState();
  if (!workspace) return "conflict";
  const expected = buffers[relPath]?.diskHash || editorRegistry.get(relPath)?.diskHash || null;
  try {
    const out = await ipc.fileWrite(workspace.id, relPath, getText(), expected);
    editorRegistry.updateDiskHash(relPath, out.contentHash);
    useWorkspace.getState().markSaved(relPath, out.contentHash);
    // Attribution signal: if a task is running, this file is now "Both",
    // so the review panel won't offer to silently discard the user's work.
    void ipc.reviewNoteUserEdit(workspace.id, relPath).catch(() => {});
    return "saved";
  } catch (e) {
    if (isConflict(e)) {
      useWorkspace.getState().markConflict(relPath);
      return "conflict";
    }
    throw e;
  }
}
