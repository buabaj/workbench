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
  tabs: string[];
  active: string | null;
  buffers: Record<string, BufferMeta>;

  setMode(mode: "code" | "research"): void;
  pickWorkspace(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  loadChildren(subpath: string): Promise<void>;
  toggleDir(relPath: string): void;
  openFile(relPath: string): void;
  closeFile(relPath: string): void;
  setActive(relPath: string): void;
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
  tabs: [],
  active: null,
  buffers: {},

  setMode: (mode) => set({ mode }),

  pickWorkspace: async () => {
    const ws = await ipc.workspacePick();
    if (ws) {
      editorRegistry.clear();
      set({ workspace: ws, childrenByPath: {}, expanded: {}, tabs: [], active: null, buffers: {} });
      await get().loadChildren("");
    }
  },

  openWorkspace: async (path) => {
    const ws = await ipc.workspaceOpen(path);
    editorRegistry.clear();
    set({ workspace: ws, childrenByPath: {}, expanded: {}, tabs: [], active: null, buffers: {} });
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
    set((s) => ({
      tabs: s.tabs.includes(relPath) ? s.tabs : [...s.tabs, relPath],
      active: relPath,
      mode: relPath.toLowerCase().endsWith(".md") ? "research" : "code",
    }));
  },

  closeFile: (relPath) => {
    editorRegistry.delete(relPath);
    set((s) => {
      const tabs = s.tabs.filter((t) => t !== relPath);
      const buffers = { ...s.buffers };
      delete buffers[relPath];
      return {
        tabs,
        buffers,
        active: s.active === relPath ? (tabs[tabs.length - 1] ?? null) : s.active,
      };
    });
  },

  setActive: (relPath) =>
    set({
      active: relPath,
      mode: relPath.toLowerCase().endsWith(".md") ? "research" : "code",
    }),

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
    return "saved";
  } catch (e) {
    if (isConflict(e)) {
      useWorkspace.getState().markConflict(relPath);
      return "conflict";
    }
    throw e;
  }
}
