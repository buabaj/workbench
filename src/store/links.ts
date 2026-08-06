import { create } from "zustand";
import { ipc, type FileLinks, type LinkView } from "../ipc/client";

/** A selection captured from an editor, pinned as one end of a pending link. */
export interface PinnedSelection {
  relPath: string;
  from: number;
  to: number;
  excerpt: string;
}

export const LINK_KINDS = [
  "supports",
  "implements",
  "tests",
  "contradicts",
  "derived_from",
] as const;

interface LinksStore {
  /** Live selection in the active editor (null when collapsed). */
  selection: PinnedSelection | null;
  /** The source end of a link being built. */
  pinned: PinnedSelection | null;
  links: FileLinks;
  busy: boolean;
  error: string | null;

  setSelection(sel: PinnedSelection | null): void;
  pin(): void;
  clearPin(): void;
  createLink(workspaceId: string, kind: string): Promise<void>;
  deleteLink(workspaceId: string, id: string, relPath: string): Promise<void>;
  loadLinks(workspaceId: string, relPath: string): Promise<void>;
}

const EMPTY: FileLinks = { outgoing: [], incoming: [] };

export const useLinks = create<LinksStore>((set, get) => ({
  selection: null,
  pinned: null,
  links: EMPTY,
  busy: false,
  error: null,

  setSelection: (selection) => set({ selection }),

  pin: () => {
    const sel = get().selection;
    if (sel) set({ pinned: sel, error: null });
  },

  clearPin: () => set({ pinned: null }),

  createLink: async (workspaceId, kind) => {
    const { pinned, selection } = get();
    if (!pinned || !selection) return;
    set({ busy: true, error: null });
    try {
      await ipc.linkCreate(
        workspaceId,
        kind,
        { relPath: pinned.relPath, from: pinned.from, to: pinned.to },
        { relPath: selection.relPath, from: selection.from, to: selection.to },
        null,
      );
      set({ pinned: null });
      await get().loadLinks(workspaceId, selection.relPath);
    } catch (e) {
      set({ error: String((e as { detail?: unknown })?.detail ?? e) });
    } finally {
      set({ busy: false });
    }
  },

  deleteLink: async (workspaceId, id, relPath) => {
    await ipc.linkDelete(id).catch(() => {});
    await get().loadLinks(workspaceId, relPath);
  },

  loadLinks: async (workspaceId, relPath) => {
    try {
      const links = await ipc.linksForFile(workspaceId, relPath);
      set({ links });
    } catch {
      set({ links: EMPTY });
    }
  },
}));

/** The far end of a link relative to the file currently open. */
export function otherEnd(link: LinkView, relPath: string) {
  return link.src.relPath === relPath ? link.dst : link.src;
}
