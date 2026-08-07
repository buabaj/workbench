import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { FileIcon, FolderIcon } from "../icons/fileIcon";
import { formatError, ipc, type TreeNode } from "../ipc/client";

function parentOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useWorkspace((s) => s.expanded[node.relPath] ?? false);
  const active = useLayout((s) => s.activeFile() === node.relPath);
  const phase = useWorkspace((s) => s.buffers[node.relPath]?.phase);
  const toggleDir = useWorkspace((s) => s.toggleDir);
  const openFile = useWorkspace((s) => s.openFile);
  const selectDir = useWorkspace((s) => s.selectDir);
  const selectedDir = useWorkspace((s) => s.selectedDir);

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
          // Listed but de-emphasised: present when you need it (.env), never
          // competing with tracked files for attention.
          style={node.ignored ? { ...indent, opacity: 0.55 } : indent}
        >
          <span className="twisty" aria-hidden>
            {expanded ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
          </span>
          <FolderIcon open={expanded} />
          <span className="label">{node.name}</span>
        </div>
        {expanded && <Children subpath={node.relPath} depth={depth + 1} />}
      </>
    );
  }

  const stateLabel =
    phase === "dirty" ? ", unsaved changes" : phase === "conflict" ? ", changed on disk" : "";

  return (
    <div
      className={`rail-item ${active ? "on" : ""}`}
      style={node.ignored ? { ...indent, opacity: 0.55 } : indent}
      role="treeitem"
      aria-selected={active}
      aria-label={`${node.name}${stateLabel}${node.ignored ? ", git-ignored" : ""}`}
      tabIndex={0}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      <span className="twisty" aria-hidden />
      <FileIcon name={node.name} />
      <span className="label">{node.name}</span>
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
