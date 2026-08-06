import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";
import { FileIcon, FolderIcon } from "../icons/fileIcon";
import type { TreeNode } from "../ipc/client";

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useWorkspace((s) => s.expanded[node.relPath] ?? false);
  const active = useLayout((s) => s.activeFile() === node.relPath);
  const phase = useWorkspace((s) => s.buffers[node.relPath]?.phase);
  const toggleDir = useWorkspace((s) => s.toggleDir);
  const openFile = useWorkspace((s) => s.openFile);

  const indent = { paddingLeft: `${8 + depth * 12}px` };
  const activate = () => (node.isDir ? toggleDir(node.relPath) : openFile(node.relPath));
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
          style={indent}
          role="treeitem"
          aria-expanded={expanded}
          aria-label={`${node.name}, folder`}
          tabIndex={0}
          onClick={activate}
          onKeyDown={onKeyDown}
        >
          <span className="twisty" aria-hidden>
            {expanded ? "▾" : "▸"}
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
      style={indent}
      role="treeitem"
      aria-selected={active}
      aria-label={`${node.name}${stateLabel}`}
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

export function FileTree() {
  const workspace = useWorkspace((s) => s.workspace);
  if (!workspace) return null;
  return (
    <div role="tree" aria-label="Workspace files">
      <Children subpath="" depth={0} />
    </div>
  );
}
