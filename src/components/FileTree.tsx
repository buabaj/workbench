import { useWorkspace } from "../store/workspace";
import type { TreeNode } from "../ipc/client";

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useWorkspace((s) => s.expanded[node.relPath] ?? false);
  const active = useWorkspace((s) => s.active === node.relPath);
  const phase = useWorkspace((s) => s.buffers[node.relPath]?.phase);
  const toggleDir = useWorkspace((s) => s.toggleDir);
  const openFile = useWorkspace((s) => s.openFile);

  const indent = { paddingLeft: `${16 + depth * 14}px` };
  if (node.isDir) {
    return (
      <>
        <div className="rail-item" style={indent} onClick={() => toggleDir(node.relPath)}>
          <span style={{ fontSize: 9, color: "var(--ink-faint)" }}>{expanded ? "▾" : "▸"}</span>
          {node.name}
        </div>
        {expanded && <Children subpath={node.relPath} depth={depth + 1} />}
      </>
    );
  }
  return (
    <div
      className={`rail-item ${active ? "on" : ""}`}
      style={indent}
      onClick={() => openFile(node.relPath)}
    >
      {node.name}
      {phase === "dirty" && <span className="count">●</span>}
      {phase === "conflict" && (
        <span className="count" style={{ color: "var(--danger)" }}>
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
      <div className="rail-item" style={{ paddingLeft: `${16 + depth * 14}px`, color: "var(--ink-faint)" }}>
        loading…
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
  return <Children subpath="" depth={0} />;
}
