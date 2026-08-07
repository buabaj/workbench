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
}

interface LayoutStore {
  /** Which rail view is showing. In the store so other panels can switch it. */
  railTab: "files" | "search" | "changes";
  /** A file the Changes panel should scroll to and expand. */
  changesFocus: string | null;
  setRailTab(tab: "files" | "search" | "changes"): void;
  showInChanges(relPath: string): void;
  clearChangesFocus(): void;

  tabs: Tab[];
  activeTabId: string;
  railOpen: boolean;
  inspectorOpen: boolean;
  workspaceId: string | null;
  /** Per-file Markdown view: source (default) or rendered preview. */
  mdPreview: Record<string, boolean>;

  openFileTab(relPath: string): void;
  closeTab(id: string): void;
  setActive(id: string): void;
  focusChat(): void;
  openSettings(): void;
  cycleTab(delta: number): void;
  toggleMdPreview(relPath: string): void;
  toggleRail(): void;
  toggleInspector(): void;
  activeFile(): string | null;
  hydrate(workspaceId: string): Promise<void>;
}

let persistTimer: number | undefined;

export const useLayout = create<LayoutStore>((set, get) => {
  /** Debounced so dragging or rapid tab changes don't hammer SQLite. */
  const persist = () => {
    const { workspaceId, tabs, activeTabId, railOpen, inspectorOpen } = get();
    if (!workspaceId) return;
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      const payload: Persisted = {
        openFiles: tabs.filter((t) => t.kind === "file").map((t) => (t as { relPath: string }).relPath),
        activeTabId,
        railOpen,
        inspectorOpen,
      };
      void ipc.workspaceSettingSet(workspaceId, LAYOUT_KEY, payload).catch(() => {});
    }, 300);
  };

  return {
    tabs: [CHAT_TAB],
    activeTabId: "chat",
    railOpen: true,
    inspectorOpen: true,
    workspaceId: null,
    mdPreview: {},

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

    railTab: "files",
    changesFocus: null,
    setRailTab: (railTab) => set({ railTab }),
    /** Jump to the Changes view with one file open — used by task review. */
    showInChanges: (relPath) =>
      set({ railTab: "changes", changesFocus: relPath, railOpen: true }),
    clearChangesFocus: () => set({ changesFocus: null }),

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
      });
    },
  };
});
