import { Plus, X } from "lucide-react";
import { ButterflyMark } from "./ButterflyMark";
import { FileIcon } from "../icons/fileIcon";
import { useLayout, type Tab } from "../store/layout";
import { useWorkspace } from "../store/workspace";

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
        lineHeight: 1,
        minHeight: 26,
      }}
    >
      {tab.kind === "chat" ? (
        <ButterflyMark size={14} />
      ) : tab.kind === "file" ? (
        <FileIcon name={name ?? ""} />
      ) : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1 }}>{name}</span>
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
            color: "var(--ink-faint)",
            padding: 0,
            marginLeft: 2,
            cursor: "default",
            display: "inline-flex",
          }}
        >
          <X size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export function TabStrip({ onNewConversation }: { onNewConversation: () => void }) {
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
      <button
        className="btn icon"
        style={{ marginLeft: "auto" }}
        onClick={onNewConversation}
        aria-label="New conversation"
        title="New conversation — ends the current agent session"
      >
        <Plus size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
