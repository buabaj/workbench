import { create } from "zustand";
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
  buffers: Record<string, BufferMeta>;
  /** Range an editor should scroll to and select once mounted (cross-mode nav). */
  pendingReveal: { relPath: string; from: number; to: number } | null;

  setMode(mode: "code" | "research"): void;
  pickWorkspace(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  loadChildren(subpath: string): Promise<void>;
  toggleDir(relPath: string): void;
  openFile(relPath: string): void;
  revealRange(relPath: string, from: number, to: number): void;
  consumeReveal(relPath: string): { from: number; to: number } | null;
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
  buffers: {},
  pendingReveal: null,

  setMode: (mode) => set({ mode }),

  pickWorkspace: async () => {
    const ws = await ipc.workspacePick();
    if (ws) {
      editorRegistry.clear();
      set({ workspace: ws, childrenByPath: {}, expanded: {}, buffers: {} });
      await useLayout.getState().hydrate(ws.id);
      await get().loadChildren("");
    }
  },

  openWorkspace: async (path) => {
    const ws = await ipc.workspaceOpen(path);
    editorRegistry.clear();
    set({ workspace: ws, childrenByPath: {}, expanded: {}, buffers: {} });
    await useLayout.getState().hydrate(ws.id);
    await get().loadChildren("");
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

  openFile: (relPath) => {
    useLayout.getState().openFileTab(relPath);
  },

  revealRange: (relPath, from, to) => {
    // Activating the tab mounts the editor, which consumes the reveal — so
    // navigation works whether the target was open, behind chat, or closed.
    useLayout.getState().openFileTab(relPath);
    set({ pendingReveal: { relPath, from, to } });
  },

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
