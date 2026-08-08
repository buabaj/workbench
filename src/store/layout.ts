import { create } from "zustand";
import { ipc } from "../ipc/client";
import { editorRegistry } from "../editor/editorRegistry";

/**
 * Centre tabs and chrome geometry.
 *
 * Chat is a TAB, not a mode: a mode would hide the tab strip and the file you
 * were reading, while the goal is to watch the conversation and glance at a
 * file without losing either. It is pinned at index 0 and cannot be closed.
 *
 * Tabs deliberately do NOT live in `store/workspace.ts` as a `string[]` — that
 * array was keyed into `buffers` and `editorRegistry`, so a `"__chat__"`
 * sentinel would have forced a special case into five files. A discriminated
 * union keeps non-file tabs first-class.
 */
export type Tab =
  | { id: "chat"; kind: "chat" }
  | { id: string; kind: "file"; relPath: string }
  /** A file's uncommitted change. Its own kind, not a file: it is read-only,
   *  it is derived, and it should not be mistaken for the file itself. */
  | { id: string; kind: "diff"; relPath: string }
  | { id: "settings"; kind: "settings" };

export const CHAT_TAB: Tab = { id: "chat", kind: "chat" };

export function fileTabId(relPath: string): string {
  return `file:${relPath}`;
}

const LAYOUT_KEY = "layout.v1";

interface Persisted {
  openFiles: string[];
  activeTabId: string;
  railOpen: boolean;
  inspectorOpen: boolean;
  railWidth?: number;
  inspectorWidth?: number;
  /** Which stance the workspace was last in. Per workspace, not global: a
   *  notes vault and a codebase want different answers. */
  mode?: "code" | "research";
}

interface LayoutStore {
  /**
   * Code or research. A top-level stance, not a filter: it changes what the
   * rail and inspector are FOR, because reading and writing notes wants a
   * different set of tools than changing code does.
   */
  mode: "code" | "research";
  setMode(mode: "code" | "research"): void;
  /** Which rail view is showing. In the store so other panels can switch it. */
  railTab: "files" | "search" | "changes" | "notes" | "links" | "library";
  /** A file the Changes panel should scroll to and expand. */
  changesFocus: string | null;
  setRailTab(tab: "files" | "search" | "changes" | "notes" | "links" | "library"): void;
  showInChanges(relPath: string): void;
  clearChangesFocus(): void;
  /** A query handed to the workspace search, from ⌘F or from anywhere else
   *  that already knows what you are looking for. */
  searchSeed: string | null;
  openSearch(pattern: string): void;
  clearSearchSeed(): void;

  tabs: Tab[];
  activeTabId: string;
  railOpen: boolean;
  inspectorOpen: boolean;
  workspaceId: string | null;
  /** Per-file Markdown view: source (default) or rendered preview. */
  mdPreview: Record<string, boolean>;

  openFileTab(relPath: string): void;
  openDiffTab(relPath: string): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  focusChat(): void;
  openSettings(): void;
  cycleTab(delta: number): void;
  toggleMdPreview(relPath: string): void;
  toggleRail(): void;
  toggleInspector(): void;
  /** Panel widths, in pixels, clamped and persisted per workspace. */
  railWidth: number;
  inspectorWidth: number;
  setRailWidth(px: number): void;
  setInspectorWidth(px: number): void;
  activeFile(): string | null;
  hydrate(workspaceId: string): Promise<void>;
}

/** Panel widths. Wide enough for a path, narrow enough to leave the document
 *  the room — and both are a matter of taste, which is why they are draggable. */
export const RAIL_DEFAULT = 248;
export const RAIL_MIN = 170;
export const RAIL_MAX = 520;
export const INSPECTOR_DEFAULT = 300;
export const INSPECTOR_MIN = 220;
export const INSPECTOR_MAX = 560;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

let persistTimer: number | undefined;

export const useLayout = create<LayoutStore>((set, get) => {
  /** Debounced so dragging or rapid tab changes don't hammer SQLite. */
  const persist = () => {
    const { workspaceId, tabs, activeTabId, railOpen, inspectorOpen, mode, railWidth, inspectorWidth } =
      get();
    if (!workspaceId) return;
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      const payload: Persisted = {
        openFiles: tabs.filter((t) => t.kind === "file").map((t) => (t as { relPath: string }).relPath),
        activeTabId,
        railOpen,
        inspectorOpen,
        railWidth,
        inspectorWidth,
        mode,
      };
      void ipc.workspaceSettingSet(workspaceId, LAYOUT_KEY, payload).catch(() => {});
    }, 300);
  };

  return {
    tabs: [CHAT_TAB],
    activeTabId: "chat",
    railOpen: true,
    inspectorOpen: true,
    railWidth: RAIL_DEFAULT,
    inspectorWidth: INSPECTOR_DEFAULT,
    workspaceId: null,
    mdPreview: {},

    openDiffTab: (relPath) => {
      const id = `diff:${relPath}`;
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === id)
          ? s.tabs
          : [...s.tabs, { id, kind: "diff", relPath }],
        activeTabId: id,
      }));
      persist();
    },

    openFileTab: (relPath) => {
      const id = fileTabId(relPath);
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === id)
          ? s.tabs
          : [...s.tabs, { id, kind: "file", relPath }],
        activeTabId: id,
      }));
      persist();
    },

    closeTab: (id) => {
      if (id === "chat") return; // pinned
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        const tab = s.tabs[idx];
        if (tab?.kind === "file") editorRegistry.delete(tab.relPath);
        const tabs = s.tabs.filter((t) => t.id !== id);
        const activeTabId =
          s.activeTabId === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? "chat") : s.activeTabId;
        return { tabs, activeTabId };
      });
      persist();
    },

    setActive: (id) => {
      set({ activeTabId: id });
      persist();
    },

    focusChat: () => {
      set({ activeTabId: "chat" });
      persist();
    },

    openSettings: () => {
      set((s) => ({
        tabs: s.tabs.some((t) => t.id === "settings")
          ? s.tabs
          : [...s.tabs, { id: "settings", kind: "settings" }],
        activeTabId: "settings",
      }));
      persist();
    },

    cycleTab: (delta) => {
      const { tabs, activeTabId } = get();
      const i = tabs.findIndex((t) => t.id === activeTabId);
      const next = tabs[(i + delta + tabs.length) % tabs.length];
      if (next) get().setActive(next.id);
    },

    toggleMdPreview: (relPath) =>
      set((s) => ({ mdPreview: { ...s.mdPreview, [relPath]: !s.mdPreview[relPath] } })),

    mode: "code",
    setMode: (mode) => {
      set({ mode, railTab: mode === "research" ? "notes" : "files" });
      persist();
    },
    railTab: "files",
    changesFocus: null,
    setRailTab: (railTab) => set({ railTab }),
    /** Jump to the Changes view with one file open — used by task review. */
    showInChanges: (relPath) =>
      set({ railTab: "changes", changesFocus: relPath, railOpen: true }),
    clearChangesFocus: () => set({ changesFocus: null }),

    searchSeed: null,
    // Widening a search you have already composed is the commonest next move
    // after finding nothing in this file; retyping it is the tax.
    openSearch: (pattern) =>
      set({ railTab: "search", railOpen: true, searchSeed: pattern || null }),
    clearSearchSeed: () => set({ searchSeed: null }),

    // Clamped on the way in, so a persisted width from a bigger display cannot
    // leave a panel wider than the window it is opened on.
    setRailWidth: (px) => {
      set({ railWidth: clamp(px, RAIL_MIN, RAIL_MAX) });
      persist();
    },
    setInspectorWidth: (px) => {
      set({ inspectorWidth: clamp(px, INSPECTOR_MIN, INSPECTOR_MAX) });
      persist();
    },

    toggleRail: () => {
      set((s) => ({ railOpen: !s.railOpen }));
      persist();
    },

    toggleInspector: () => {
      set((s) => ({ inspectorOpen: !s.inspectorOpen }));
      persist();
    },

    activeFile: () => {
      const { tabs, activeTabId } = get();
      const t = tabs.find((x) => x.id === activeTabId);
      return t?.kind === "file" ? t.relPath : null;
    },

    /** Restore this workspace's layout. Without it every reopen dumps you back
     * on an empty chat tab — the papercut users report about Cursor. */
    hydrate: async (workspaceId) => {
      set({ workspaceId, tabs: [CHAT_TAB], activeTabId: "chat" });
      const saved = (await ipc
        .workspaceSettingGet(workspaceId, LAYOUT_KEY)
        .catch(() => null)) as Persisted | null;
      if (!saved) return;
      const tabs: Tab[] = [
        CHAT_TAB,
        ...(saved.openFiles ?? []).map<Tab>((relPath) => ({
          id: fileTabId(relPath),
          kind: "file",
          relPath,
        })),
      ];
      const activeTabId = tabs.some((t) => t.id === saved.activeTabId)
        ? saved.activeTabId
        : "chat";
      set({
        tabs,
        activeTabId,
        railOpen: saved.railOpen ?? true,
        inspectorOpen: saved.inspectorOpen ?? true,
        railWidth: clamp(saved.railWidth ?? RAIL_DEFAULT, RAIL_MIN, RAIL_MAX),
        inspectorWidth: clamp(
          saved.inspectorWidth ?? INSPECTOR_DEFAULT,
          INSPECTOR_MIN,
          INSPECTOR_MAX,
        ),
        mode: saved.mode ?? "code",
        // The rail views differ per mode, so a stale tab from the other one
        // would land on a panel that no longer exists.
        railTab: saved.mode === "research" ? "notes" : "files",
      });
    },
  };
});
