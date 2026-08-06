import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";

/**
 * One registry read by the palette, and later by context menus and the keymap
 * settings page. Keeping it single-source means a new action becomes reachable
 * everywhere at once, and the palette doubles as the discoverability surface
 * for shortcuts — it shows each binding beside its command.
 */
export interface Command {
  id: string;
  title: string;
  keys?: string;
  group: string;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const hasWorkspace = () => useWorkspace.getState().workspace !== null;

export const COMMANDS: Command[] = [
  {
    id: "workspace.open",
    title: "Open Folder…",
    group: "Workspace",
    run: () => void useWorkspace.getState().pickWorkspace(),
  },
  {
    id: "view.chat",
    title: "Go to Chat",
    keys: "⌘L",
    group: "View",
    run: () => useLayout.getState().focusChat(),
  },
  {
    id: "view.rail",
    title: "Toggle Sidebar",
    keys: "⌘B",
    group: "View",
    run: () => useLayout.getState().toggleRail(),
  },
  {
    id: "view.inspector",
    title: "Toggle Inspector",
    keys: "⌥⌘B",
    group: "View",
    run: () => useLayout.getState().toggleInspector(),
  },
  {
    id: "view.nextTab",
    title: "Next Tab",
    keys: "⌘⇧]",
    group: "View",
    run: () => useLayout.getState().cycleTab(1),
  },
  {
    id: "view.prevTab",
    title: "Previous Tab",
    keys: "⌘⇧[",
    group: "View",
    run: () => useLayout.getState().cycleTab(-1),
  },
  {
    id: "file.close",
    title: "Close Tab",
    keys: "⌘W",
    group: "View",
    run: () => {
      const { activeTabId, closeTab } = useLayout.getState();
      closeTab(activeTabId);
    },
  },
  {
    id: "settings.open",
    title: "Settings",
    keys: "⌘,",
    group: "Workspace",
    run: () => useLayout.getState().openSettings(),
  },
  {
    id: "workspace.reindex",
    title: "Rebuild File Index",
    group: "Workspace",
    when: hasWorkspace,
    run: async () => {
      const ws = useWorkspace.getState().workspace;
      if (ws) {
        const { ipc } = await import("../ipc/client");
        await ipc.workspaceIndex(ws.id, true);
      }
    },
  },
];

export function availableCommands(): Command[] {
  return COMMANDS.filter((c) => !c.when || c.when());
}

/**
 * Subsequence fuzzy match, scoring matches at path-segment and camelCase
 * boundaries higher, and consecutive runs higher still. Returns null on no
 * match so callers can filter.
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let score = 0;
  let hi = 0;
  let run = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === ch) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return null;
    const prev = haystack[found - 1];
    const boundary = found === 0 || prev === "/" || prev === "." || prev === "_" || prev === "-";
    score += boundary ? 10 : 1;
    run = run + 1;
    score += run > 1 ? run : 0;
    hi = found + 1;
  }
  // Shorter haystacks win ties: "src/App.tsx" beats "src/components/App.tsx".
  return score - haystack.length * 0.05;
}
