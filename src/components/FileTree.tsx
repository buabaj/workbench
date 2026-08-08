import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { FileIcon, FolderIcon } from "../icons/fileIcon";
import { formatError, ipc, type TreeNode } from "../ipc/client";
import type { TreeState } from "../vcs/treeStatus";
import { useComposer } from "../store/composer";
import { FileContextMenu } from "./FileContextMenu";

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

/**
 * Colour for a git state, matching what an editor's tree does: new is green,
 * changed is the accent, gone is the error colour. Ignored files stay dim
 * whatever their state, since they are not going into a commit.
 */
function stateColor(state: TreeState): string | undefined {
  switch (state) {
    case "added":
      return "var(--diff-add)";
    case "modified":
      return "var(--clay-text)";
    case "deleted":
      return "var(--error)";
    default:
      return undefined;
  }
}

/** Rename in place, so you can see the neighbours you are naming against. */
function RenameField({ node, onDone }: { node: TreeNode; onDone: () => void }) {
  const workspace = useWorkspace((s) => s.workspace);
  const [name, setName] = useState(node.name);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Select the stem, not the extension — renaming rarely means retyping ".ts".
    const dot = node.name.lastIndexOf(".");
    ref.current?.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node.name]);

  const commit = async () => {
    const next = name.trim();
    if (!workspace || !next || next === node.name) return onDone();
    const parent = parentOf(node.relPath);
    try {
      await ipc.pathRename(workspace.id, node.relPath, `${parent ? `${parent}/` : ""}${next}`);
      await useWorkspace.getState().loadChildren(parent);
      void useWorkspace.getState().refreshGitStatus();
      onDone();
    } catch (e) {
      setErr(formatError(e));
    }
  };

  return (
    <span style={{ flex: 1, minWidth: 0 }} onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="field"
        style={{ width: "100%", fontSize: "var(--text-sm)", padding: "1px 4px" }}
        aria-label={`Rename ${node.name}`}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setErr(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        onBlur={() => !err && onDone()}
      />
      {err && (
        <span role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>
          {err}
        </span>
      )}
    </span>
  );
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const expanded = useWorkspace((s) => s.expanded[node.relPath] ?? false);
  const active = useLayout((s) => s.activeFile() === node.relPath);
  const phase = useWorkspace((s) => s.buffers[node.relPath]?.phase);
  const toggleDir = useWorkspace((s) => s.toggleDir);
  const openFile = useWorkspace((s) => s.openFile);
  const selectDir = useWorkspace((s) => s.selectDir);
  const selectedDir = useWorkspace((s) => s.selectedDir);
  const appendToChat = useComposer((s) => s.appendAndFocus);
  const focusChat = useLayout((s) => s.focusChat);
  const workspace = useWorkspace((s) => s.workspace);
  const gitStatus = useWorkspace((s) => s.gitStatus);

  const rowRef = useRef<HTMLDivElement | null>(null);

  // Bring the open file into view when it becomes active. Only on the
  // transition, so this never fights you scrolling the tree yourself.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const state = node.ignored ? null : gitStatus.of(node.relPath);
  // A collapsed folder shows a dot when something inside it changed — without
  // it you would have to open every folder to find out where the work is.
  const hidesChanges =
    node.isDir && !node.ignored && !expanded && gitStatus.containsChanges(node.relPath);

  // Right-click reaches the same reference the @-menu and the selection bubble
  // produce, so a file gets into the chat the same way from anywhere.
  const refresh = async () => {
    const parent = parentOf(node.relPath);
    await useWorkspace.getState().loadChildren(parent);
    void useWorkspace.getState().refreshGitStatus();
  };

  // Deliberately short. An editor's file menu runs to twenty entries, most of
  // which nobody uses; these are the ones reached for.
  const menuItems = [
    {
      label: "Add to chat",
      onSelect: () => {
        appendToChat(`@${node.relPath}`);
        focusChat();
      },
    },
    { label: "Rename…", onSelect: () => setRenaming(true) },
    ...(node.isDir
      ? []
      : [
          {
            label: "Duplicate",
            onSelect: () => {
              if (!workspace) return;
              const dot = node.name.lastIndexOf(".");
              const stem = dot > 0 ? node.name.slice(0, dot) : node.name;
              const ext = dot > 0 ? node.name.slice(dot) : "";
              const parent = parentOf(node.relPath);
              const to = `${parent ? `${parent}/` : ""}${stem} copy${ext}`;
              void ipc.pathDuplicate(workspace.id, node.relPath, to).then(refresh).catch(() => {});
            },
          },
        ]),
    {
      label: "Copy path",
      onSelect: () => void navigator.clipboard.writeText(node.relPath).catch(() => {}),
    },
    {
      label: "Reveal in Finder",
      onSelect: () => {
        if (workspace) void ipc.pathReveal(workspace.id, node.relPath).catch(() => {});
      },
    },
    {
      label: "Move to Trash",
      onSelect: () => {
        if (!workspace) return;
        // The Trash, not an unlink — recoverable in Finder, so a misclick in a
        // context menu cannot destroy work.
        void ipc.pathTrash(workspace.id, node.relPath).then(refresh).catch(() => {});
      },
    },
  ];

  const indent = { paddingLeft: `${8 + depth * 12}px` };
  const activate = () => {
    if (!node.isDir) return openFile(node.relPath);
    // Clicking a folder also makes it the place new files land. Collapsing it
    // hands that back to the root, so the target is always something visible.
    const willExpand = !expanded;
    toggleDir(node.relPath);
    selectDir(willExpand ? node.relPath : parentOf(node.relPath));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    } else if (e.key === "ArrowRight" && node.isDir && !expanded) {
      toggleDir(node.relPath);
    } else if (e.key === "ArrowLeft" && node.isDir && expanded) {
      toggleDir(node.relPath);
    }
  };

  if (node.isDir) {
    return (
      <>
        <div
          className="rail-item"
          role="treeitem"
          aria-expanded={expanded}
          aria-label={`${node.name}, folder${node.ignored ? ", git-ignored" : ""}${
            selectedDir === node.relPath ? ", selected" : ""
          }`}
          tabIndex={0}
          onClick={activate}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          // Listed but de-emphasised: present when you need it (.env), never
          // competing with tracked files for attention.
          style={node.ignored ? { ...indent, opacity: 0.55 } : indent}
        >
          <span className="twisty" aria-hidden>
            {expanded ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
          </span>
          <FolderIcon open={expanded} />
          {renaming ? (
            <RenameField node={node} onDone={() => setRenaming(false)} />
          ) : (
            <span className="label">{node.name}</span>
          )}
          {hidesChanges && (
            <span
              className="count git-dot"
              title="Contains uncommitted changes"
              aria-label="contains uncommitted changes"
            >
              ●
            </span>
          )}
        </div>
        {expanded && <Children subpath={node.relPath} depth={depth + 1} />}
        {menu && (
          <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
        )}
      </>
    );
  }

  const stateLabel =
    phase === "dirty" ? ", unsaved changes" : phase === "conflict" ? ", changed on disk" : "";

  return (
    <div
      ref={rowRef}
      className={`rail-item ${active ? "on" : ""}`}
      style={node.ignored ? { ...indent, opacity: 0.55 } : indent}
      role="treeitem"
      aria-selected={active}
      aria-label={`${node.name}${stateLabel}${node.ignored ? ", git-ignored" : ""}`}
      tabIndex={0}
      onClick={activate}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <span className="twisty" aria-hidden />
      <FileIcon name={node.name} />
      {renaming ? (
        <RenameField node={node} onDone={() => setRenaming(false)} />
      ) : (
        <span className="label" style={{ color: stateColor(state) }}>
          {node.name}
        </span>
      )}
      {phase === "dirty" && (
        <span className="count" style={{ color: "var(--clay-text)" }} aria-hidden>
          ●
        </span>
      )}
      {phase === "conflict" && (
        <span className="count" style={{ color: "var(--error)" }} aria-hidden>
          ⚠
        </span>
      )}
      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function Children({ subpath, depth }: { subpath: string; depth: number }) {
  const nodes = useWorkspace((s) => s.childrenByPath[subpath]);
  if (!nodes) {
    return (
      <div className="rail-item" style={{ paddingLeft: `${8 + depth * 12}px`, color: "var(--ink-faint)" }} aria-busy="true">
        loading…
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="rail-item" style={{ paddingLeft: `${8 + depth * 12}px`, color: "var(--ink-faint)" }}>
        empty
      </div>
    );
  }
  return (
    <>
      {nodes.map((n) => (
        <Row key={n.relPath} node={n} depth={depth} />
      ))}
    </>
  );
}

/**
 * Inline create row.
 *
 * A row in the tree rather than a modal: you are naming a thing in a place,
 * and the place should stay visible while you do it. A path with slashes is
 * accepted — `src/api/handlers.rs` creates the parents too, the way typing a
 * path into an editor's new-file prompt does.
 */
function CreateRow({
  kind,
  onDone,
}: {
  kind: "file" | "dir";
  onDone: () => void;
}) {
  const workspace = useWorkspace((s) => s.workspace);
  const loadChildren = useWorkspace((s) => s.loadChildren);
  const openFile = useWorkspace((s) => s.openFile);
  const selectedDir = useWorkspace((s) => s.selectedDir);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const commit = async () => {
    const typed = name.trim().replace(/^\/+/, "");
    // Relative to the folder you last opened, the way an editor's "new file"
    // is. A leading "/" is the escape hatch back to the workspace root.
    const path =
      selectedDir && !name.trim().startsWith("/") ? `${selectedDir}/${typed}` : typed;
    if (!workspace || !typed) return onDone();
    try {
      if (kind === "file") {
        await ipc.fileCreate(workspace.id, path);
      } else {
        await ipc.dirCreate(workspace.id, path);
      }
      // Refresh the level the thing landed in, not just the root.
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      await loadChildren("");
      if (parent) await loadChildren(parent).catch(() => {});
      if (kind === "file") openFile(path);
      onDone();
    } catch (e) {
      setErr(formatError(e));
    }
  };

  return (
    <div style={{ padding: "2px 8px" }}>
      {selectedDir && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", padding: "0 2px 2px" }}>
          in {selectedDir}/
        </div>
      )}
      <input
        ref={ref}
        className="field"
        style={{ fontSize: "var(--text-sm)", padding: "3px 6px" }}
        placeholder={
          selectedDir
            ? `${selectedDir}/${kind === "file" ? "name.ext" : "folder"}`
            : kind === "file"
              ? "path/name.ext"
              : "folder name"
        }
        aria-label={kind === "file" ? "New file path" : "New folder name"}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        // Clicking away cancels rather than silently creating something.
        onBlur={() => !err && onDone()}
      />
      {err && (
        <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)", padding: "2px 2px 0" }}>
          {err}
        </div>
      )}
    </div>
  );
}

/** `creating` is owned by the rail header, where the two buttons live. */
export function FileTree({
  creating = null,
  onCreateDone,
}: {
  creating?: "file" | "dir" | null;
  onCreateDone?: () => void;
}) {
  const workspace = useWorkspace((s) => s.workspace);
  if (!workspace) return null;
  return (
    <div>
      {creating && <CreateRow kind={creating} onDone={() => onCreateDone?.()} />}
      <div role="tree" aria-label="Workspace files">
        <Children subpath="" depth={0} />
      </div>
    </div>
  );
}
