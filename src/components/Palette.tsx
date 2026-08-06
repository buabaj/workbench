import { useEffect, useMemo, useRef, useState } from "react";
import { availableCommands, fuzzyScore, type Command } from "../commands/registry";
import { FileIcon } from "../icons/fileIcon";
import { ipc } from "../ipc/client";
import { useWorkspace } from "../store/workspace";

export type PaletteMode = "files" | "commands";

interface Row {
  key: string;
  label: string;
  detail?: string;
  keys?: string;
  icon?: React.ReactNode;
  run: () => void;
}

export function Palette({
  mode,
  onClose,
}: {
  mode: PaletteMode;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const workspace = useWorkspace((s) => s.workspace);
  const openFile = useWorkspace((s) => s.openFile);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (mode !== "files" || !workspace) return;
    void ipc.workspaceIndex(workspace.id, false).then(setFiles).catch(() => setFiles([]));
  }, [mode, workspace?.id]);

  const rows = useMemo<Row[]>(() => {
    if (mode === "commands") {
      const scored = availableCommands()
        .map((c: Command) => ({ c, s: fuzzyScore(c.title, query) }))
        .filter((x): x is { c: Command; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60);
      return scored.map(({ c }) => ({
        key: c.id,
        label: c.title,
        detail: c.group,
        keys: c.keys,
        run: () => void c.run(),
      }));
    }
    const scored = files
      .map((f) => ({ f, s: fuzzyScore(f, query) }))
      .filter((x): x is { f: string; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 100);
    return scored.map(({ f }) => {
      const name = f.split("/").pop() ?? f;
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      return {
        key: f,
        label: name,
        detail: dir,
        icon: <FileIcon name={name} />,
        run: () => openFile(f),
      };
    });
  }, [mode, query, files, openFile]);

  useEffect(() => setIndex(0), [query, mode]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-sel="1"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const commit = (row?: Row) => {
    const target = row ?? rows[index];
    if (target) target.run();
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--ink) 12%, transparent)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={mode === "files" ? "Open file" : "Run command"}
        style={{
          width: 560,
          maxWidth: "90vw",
          background: "var(--canvas)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-panel)",
          boxShadow: "var(--lift-strong)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "files" ? "Go to file…" : "Run a command…"}
          aria-label={mode === "files" ? "Go to file" : "Run a command"}
          style={{
            width: "100%",
            border: "none",
            borderBottom: "1px solid var(--border)",
            background: "transparent",
            padding: "var(--s-3) var(--s-4)",
            font: "inherit",
            fontSize: "var(--text-md)",
            color: "var(--ink)",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto", padding: "var(--s-1)" }}>
          {rows.length === 0 && (
            <div style={{ padding: "var(--s-4)", color: "var(--ink-faint)", fontSize: "var(--text-sm)" }}>
              {mode === "files" && !workspace ? "Open a workspace first." : "No matches."}
            </div>
          )}
          {rows.map((row, i) => (
            <div
              key={row.key}
              data-sel={i === index ? "1" : undefined}
              onMouseEnter={() => setIndex(i)}
              onClick={() => commit(row)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-2)",
                padding: "7px var(--s-3)",
                borderRadius: "var(--r-control)",
                background: i === index ? "var(--clay-wash)" : "transparent",
                cursor: "default",
              }}
            >
              {row.icon}
              <span style={{ color: "var(--ink)", flexShrink: 0 }}>{row.label}</span>
              {row.detail && (
                <span
                  style={{
                    color: "var(--ink-faint)",
                    fontSize: "var(--text-xs)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.detail}
                </span>
              )}
              {row.keys && (
                <kbd
                  style={{
                    marginLeft: "auto",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--ink-faint)",
                  }}
                >
                  {row.keys}
                </kbd>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
