import { FileIcon } from "../icons/fileIcon";
import { useLayout, type Tab } from "../store/layout";
import { useWorkspace } from "../store/workspace";

function ChatGlyph() {
  // Two dots and a stroke — the same dot vocabulary as the state indicator.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="4" cy="5" r="1.6" fill="var(--clay)" />
      <circle cx="8.5" cy="5" r="1.6" fill="var(--clay)" />
      <path
        d="M2 9.5h8.5"
        stroke="var(--clay)"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

function TabButton({ tab }: { tab: Tab }) {
  const active = useLayout((s) => s.activeTabId === tab.id);
  const setActive = useLayout((s) => s.setActive);
  const closeTab = useLayout((s) => s.closeTab);
  const phase = useWorkspace((s) =>
    tab.kind === "file" ? s.buffers[tab.relPath]?.phase : undefined,
  );

  const name =
    tab.kind === "chat" ? "Chat" : tab.kind === "settings" ? "Settings" : tab.relPath.split("/").pop();
  const closable = tab.kind !== "chat";

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={`${name}${phase === "dirty" ? ", unsaved" : ""}`}
      tabIndex={0}
      onClick={() => setActive(tab.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActive(tab.id);
        } else if (closable && (e.key === "Backspace" || e.key === "Delete")) {
          e.preventDefault();
          closeTab(tab.id);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px 5px 8px",
        fontSize: "var(--text-sm)",
        fontWeight: active ? 500 : 400,
        color: active ? "var(--ink)" : "var(--ink-muted)",
        background: active ? "var(--canvas)" : "transparent",
        border: `1px solid ${active ? "var(--border)" : "transparent"}`,
        borderRadius: "var(--r-control)",
        whiteSpace: "nowrap",
        cursor: "default",
        maxWidth: 200,
      }}
    >
      {tab.kind === "chat" ? (
        <ChatGlyph />
      ) : tab.kind === "file" ? (
        <FileIcon name={name ?? ""} />
      ) : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      {phase === "dirty" && (
        <span aria-hidden style={{ color: "var(--clay-text)", fontSize: 9 }}>
          ●
        </span>
      )}
      {closable && (
        <button
          aria-label={`Close ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}
          style={{
            background: "none",
            border: "none",
            font: "inherit",
            fontSize: 11,
            color: "var(--ink-faint)",
            padding: 0,
            marginLeft: 2,
            cursor: "default",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function TabStrip() {
  const tabs = useLayout((s) => s.tabs);
  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      style={{
        display: "flex",
        gap: 2,
        padding: "var(--s-2) var(--s-3)",
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => (
        <TabButton key={t.id} tab={t} />
      ))}
    </div>
  );
}
