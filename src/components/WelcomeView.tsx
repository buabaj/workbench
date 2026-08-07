import { BookOpen, FolderOpen, Code2, Clock } from "lucide-react";
import { ButterflyMark } from "./ButterflyMark";
import { ipc, type WorkspaceView } from "../ipc/client";
import { useEffect, useState } from "react";
import { useWorkspace } from "../store/workspace";

/**
 * What you see before a workspace is open.
 *
 * The chat's empty state asked "what are we building?" — a reasonable question
 * with nowhere to send the answer, since nothing can be built until a folder
 * is chosen. This says what the app is and offers the one action that makes
 * sense from here.
 */
function Mode({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "flex-start" }}>
      <span style={{ color: "var(--clay-text)", marginTop: 3, flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ color: "var(--ink)", fontSize: "var(--text-base)", marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ color: "var(--ink-muted)", fontSize: "var(--text-sm)", lineHeight: 1.55 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function WelcomeView() {
  const pickWorkspace = useWorkspace((s) => s.pickWorkspace);
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const [recent, setRecent] = useState<WorkspaceView[]>([]);

  useEffect(() => {
    void ipc.workspaceRecent().then(setRecent).catch(() => {});
  }, []);

  return (
    <div
      style={{
        maxWidth: 620,
        margin: "0 auto",
        padding: "var(--s-16) var(--s-6) var(--s-8)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <ButterflyMark size={34} />
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontVariationSettings: "var(--serif-settings)",
            fontSize: "var(--display-sm)",
            letterSpacing: "var(--track-snug)",
            color: "var(--ink)",
            margin: 0,
          }}
        >
          Workbench
        </h1>
      </div>

      <p
        style={{
          fontFamily: "var(--serif)",
          fontVariationSettings: "var(--serif-settings)",
          fontSize: "var(--text-lg, 1.125rem)",
          lineHeight: 1.5,
          color: "var(--ink-secondary)",
          margin: "var(--s-4) 0 var(--s-6)",
        }}
      >
        A place to read and to build, with an agent that works on the same files you do.
        Everything stays on this Mac, in folders you can open with anything else.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        <Mode icon={<Code2 size={16} strokeWidth={1.8} />} title="Code">
          Editor, terminal, find-and-replace, and a live view of what has changed. Ask the agent
          for something and review its work before you keep it.
        </Mode>
        <Mode icon={<BookOpen size={16} strokeWidth={1.8} />} title="Research">
          Search papers, read them here, and highlight a passage to ask about it or annotate it.
          Notes link to each other with <span style={{ fontFamily: "var(--mono)" }}>[[…]]</span>,
          and backlinks show what points where.
        </Mode>
      </div>

      <div style={{ display: "flex", gap: "var(--s-2)", margin: "var(--s-8) 0 var(--s-4)" }}>
        <button className="btn primary" onClick={() => void pickWorkspace()}>
          <FolderOpen size={14} strokeWidth={1.8} />
          Open a folder
        </button>
      </div>

      {recent.length > 0 && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              margin: "var(--s-4) 0 var(--s-2)",
            }}
          >
            <Clock size={11} strokeWidth={1.8} />
            Recent
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {recent.slice(0, 5).map((w) => (
              <div
                key={w.id}
                className="rail-item"
                role="button"
                tabIndex={0}
                title={w.rootPath}
                style={{ margin: 0 }}
                onClick={() => void openWorkspace(w.rootPath)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openWorkspace(w.rootPath);
                  }
                }}
              >
                <span className="label" style={{ color: "var(--ink)" }}>
                  {w.name}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-faint)",
                    marginLeft: "auto",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "55%",
                    direction: "rtl",
                  }}
                >
                  {w.rootPath}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          marginTop: "var(--s-8)",
          lineHeight: 1.6,
        }}
      >
        A folder of code or a folder of notes — the same workspace does both, and the switch in
        the title bar decides which tools you get.
      </p>
    </div>
  );
}
