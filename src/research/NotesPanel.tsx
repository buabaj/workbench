import { FileDown, FileText, FilePlus, Link2Off } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatError, ipc, onFsChanged, type NoteDoc } from "../ipc/client";
import { FileContextMenu } from "../components/FileContextMenu";
import { useComposer } from "../store/composer";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { frontmatterField } from "./frontmatter";
import { noteName, unresolvedTargets } from "./wikilinks";

/**
 * The vault: every note, and the notes it is asking for.
 *
 * Unresolved `[[links]]` are listed alongside the notes that exist, because in
 * a vault they are the same kind of thing — one has been written and one has
 * not. Clicking an unresolved link creates it, which is how a note vault is
 * meant to grow: you write the link first and the note follows.
 */

/** One save touches several paths; coalesce before re-reading the vault. */
const RESCAN_DEBOUNCE_MS = 300;

export function useVault() {
  const workspace = useWorkspace((s) => s.workspace);
  const [docs, setDocs] = useState<NoteDoc[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let timer: number | undefined;
    const scan = () =>
      void ipc
        .notesScan(workspace.id)
        .then((d) => {
          setDocs(d);
          setErr(null);
        })
        .catch((e) => setErr(formatError(e)));
    scan();
    const un = onFsChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(scan, RESCAN_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, [workspace?.id]);

  return { docs, err };
}

/**
 * One note in the list.
 *
 * Its own component so each row can own its context menu — the same
 * right-click actions the file tree has, because a note is exactly the kind of
 * thing you want to hand to the agent without opening it first.
 */
function NoteRow({
  relPath,
  active,
  hasPdf,
}: {
  relPath: string;
  active: boolean;
  hasPdf: boolean;
}) {
  const openFileTab = useLayout((s) => s.openFileTab);
  const focusChat = useLayout((s) => s.focusChat);
  const appendToChat = useComposer((s) => s.appendAndFocus);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className={`rail-item ${active ? "on" : ""}`}
      role="button"
      tabIndex={0}
      title={relPath}
      onClick={() => openFileTab(relPath)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openFileTab(relPath);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <span className="twisty" aria-hidden />
      <FileText size={12} strokeWidth={1.7} style={{ flexShrink: 0, color: "var(--ink-faint)" }} />
      <span className="label">{noteName(relPath)}</span>
      {hasPdf && (
        <span
          className="count"
          style={{ color: "var(--clay-text)", display: "inline-flex" }}
          title="Has a PDF"
        >
          <FileDown size={11} strokeWidth={1.9} />
          <span className="sr-only">has a PDF</span>
        </span>
      )}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Add to chat",
              onSelect: () => {
                appendToChat(`@${relPath}`);
                focusChat();
              },
            },
            {
              label: "Copy path",
              onSelect: () => void navigator.clipboard.writeText(relPath).catch(() => {}),
            },
          ]}
        />
      )}
    </div>
  );
}

export function NotesPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const openFileTab = useLayout((s) => s.openFileTab);
  const activeFile = useLayout((s) => s.activeFile());
  const { docs, err } = useVault();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const paths = useMemo(() => docs.map((d) => d.relPath), [docs]);
  const missing = useMemo(() => unresolvedTargets(docs, paths), [docs, paths]);

  const create = async (rawName: string) => {
    if (!workspace) return;
    const trimmed = rawName.trim();
    if (!trimmed) return setCreating(false);
    // `.md` is implied: a vault is markdown, and making people type the
    // extension is a tax on the most common action there is.
    const path = /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
    try {
      await ipc.fileCreate(workspace.id, path);
      openFileTab(path);
      setCreating(false);
      setName("");
      setCreateErr(null);
    } catch (e) {
      setCreateErr(formatError(e));
    }
  };

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 var(--s-2) 4px" }}>
        <span style={{ flex: 1, fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
          {docs.length} note{docs.length === 1 ? "" : "s"}
        </span>
        <button
          className="btn icon"
          aria-label="New note"
          title="New note"
          onClick={() => setCreating(true)}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <FilePlus size={13} strokeWidth={1.7} />
        </button>
      </div>

      {creating && (
        <div style={{ padding: "2px 8px 6px" }}>
          <input
            ref={inputRef}
            className="field"
            style={{ fontSize: "var(--text-sm)", padding: "3px 6px" }}
            placeholder="Note name"
            aria-label="New note name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setCreateErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void create(name);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCreating(false);
              }
            }}
            onBlur={() => !createErr && setCreating(false)}
          />
          {createErr && (
            <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>
              {createErr}
            </div>
          )}
        </div>
      )}

      {err && (
        <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)", padding: "0 8px" }}>
          {err}
        </div>
      )}

      {docs.map((d) => (
        <NoteRow
          key={d.relPath}
          relPath={d.relPath}
          active={activeFile === d.relPath}
          hasPdf={Boolean(frontmatterField(d.text, "pdf"))}
        />
      ))}

      {missing.length > 0 && (
        <div style={{ marginTop: "var(--s-3)" }}>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              padding: "0 var(--s-2) 4px",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Link2Off size={11} strokeWidth={1.7} />
            Not written yet
          </div>
          {missing.map((t) => (
            <div
              key={t}
              className="rail-item"
              role="button"
              tabIndex={0}
              title={`Create ${t}.md`}
              onClick={() => void create(t)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void create(t);
                }
              }}
            >
              <span className="twisty" aria-hidden />
              <FilePlus size={12} strokeWidth={1.7} style={{ flexShrink: 0, color: "var(--ink-faint)" }} />
              <span className="label" style={{ color: "var(--ink-muted)" }}>
                {t}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
