import { useEffect } from "react";
import type { AnchorStatus, LinkView } from "../ipc/client";
import { LINK_KINDS, otherEnd, useLinks } from "../store/links";
import { useWorkspace } from "../store/workspace";

const KIND_LABEL: Record<string, string> = {
  supports: "SUPPORTS",
  implements: "IMPLEMENTS",
  tests: "TESTS",
  contradicts: "CONTRADICTS",
  derived_from: "DERIVED FROM",
};

function statusStyle(status: AnchorStatus): React.CSSProperties {
  switch (status) {
    case "ok":
      return { color: "var(--link)" };
    case "stale":
      return { color: "var(--link)", borderBottom: "1px dashed var(--ink-faint)" };
    case "broken":
      return { color: "var(--ink-faint)", textDecoration: "line-through" };
  }
}

function LinkRow({ link, relPath }: { link: LinkView; relPath: string }) {
  const far = otherEnd(link, relPath);
  const workspace = useWorkspace((s) => s.workspace);
  const revealRange = useWorkspace((s) => s.revealRange);
  const deleteLink = useLinks((s) => s.deleteLink);

  const navigate = () => {
    if (far.status === "broken") return;
    revealRange(far.relPath, far.from, far.to);
  };

  return (
    <div
      style={{
        padding: "7px 0",
        borderTop: "1px solid var(--border)",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: "var(--clay-text)", fontSize: 9, letterSpacing: "0.1em" }}>
          {KIND_LABEL[link.kind] ?? link.kind.toUpperCase()}
        </span>
        <span
          style={{
            flex: 1,
            cursor: far.status === "broken" ? "default" : "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            ...statusStyle(far.status),
          }}
          onClick={navigate}
          title={far.status === "broken" ? "target not found" : far.relPath}
        >
          {far.relPath.split("/").pop()}
        </span>
        <span
          style={{ color: "var(--ink-faint)", fontSize: 10, cursor: "pointer" }}
          onClick={() =>
            workspace && void deleteLink(workspace.id, link.id, relPath)
          }
          title="Delete link"
        >
          ✕
        </span>
      </div>
      <div
        style={{
          color: "var(--ink-faint)",
          fontSize: 10,
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {far.excerpt}
      </div>
      {far.status === "stale" && (
        <div style={{ color: "var(--ink-muted)", fontSize: 10, marginTop: 2 }}>
          re-anchored, {Math.round(far.confidence * 100)}% match
        </div>
      )}
      {far.status === "broken" && (
        <div style={{ color: "var(--ink-muted)", fontSize: 10, marginTop: 2 }}>
          target not found — original text kept above
        </div>
      )}
    </div>
  );
}

export function LinksPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const active = useWorkspace((s) => s.active);
  const selection = useLinks((s) => s.selection);
  const pinned = useLinks((s) => s.pinned);
  const links = useLinks((s) => s.links);
  const busy = useLinks((s) => s.busy);
  const error = useLinks((s) => s.error);
  const pin = useLinks((s) => s.pin);
  const clearPin = useLinks((s) => s.clearPin);
  const createLink = useLinks((s) => s.createLink);
  const loadLinks = useLinks((s) => s.loadLinks);

  useEffect(() => {
    if (workspace && active) void loadLinks(workspace.id, active);
  }, [workspace?.id, active, loadLinks]);

  if (!workspace || !active) {
    return <div className="panel-empty">Open a file to see its links.</div>;
  }

  const canComplete =
    pinned && selection && !(pinned.relPath === selection.relPath && pinned.from === selection.from);

  return (
    <div>
      {/* Link builder */}
      {pinned ? (
        <div
          style={{
            border: "1px solid var(--clay-hover)",
            borderRadius: "var(--r-card)",
            padding: "8px 10px",
            marginBottom: 10,
            fontSize: 11,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ color: "var(--ink-faint)", fontSize: 9, letterSpacing: "0.1em" }}>
              FROM {pinned.relPath.split("/").pop()}
            </span>
            <span
              style={{ color: "var(--ink-faint)", cursor: "pointer", fontSize: 10 }}
              onClick={clearPin}
            >
              ✕
            </span>
          </div>
          <div style={{ color: "var(--ink-muted)", marginTop: 3, fontSize: 10 }}>
            {pinned.excerpt}
          </div>
          {canComplete ? (
            <>
              <div style={{ color: "var(--ink-faint)", fontSize: 9, marginTop: 8 }}>
                TO {selection.relPath.split("/").pop()} — pick a relationship:
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                {LINK_KINDS.map((k) => (
                  <button
                    key={k}
                    className="btn"
                    style={{ fontSize: 9, padding: "3px 7px" }}
                    disabled={busy}
                    onClick={() => void createLink(workspace.id, k)}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div style={{ color: "var(--ink-faint)", fontSize: 10, marginTop: 8 }}>
              Now select the other end — in this file or another.
            </div>
          )}
        </div>
      ) : (
        selection && (
          <button
            className="btn"
            style={{ fontSize: 10, marginBottom: 10, width: "100%" }}
            onClick={pin}
          >
            Link from this selection…
          </button>
        )
      )}

      {error && (
        <div style={{ color: "var(--error)", fontSize: 10, marginBottom: 8 }}>{error}</div>
      )}

      {links.outgoing.length === 0 && links.incoming.length === 0 && !pinned && !selection && (
        <div className="panel-empty">
          Select text in a file to start a link between research and code.
        </div>
      )}

      {links.outgoing.length > 0 && (
        <>
          <div style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--ink-faint)" }}>
            OUTGOING
          </div>
          {links.outgoing.map((l) => (
            <LinkRow key={l.id} link={l} relPath={active} />
          ))}
        </>
      )}
      {links.incoming.length > 0 && (
        <>
          <div
            style={{
              fontSize: 9,
              letterSpacing: "0.12em",
              color: "var(--ink-faint)",
              marginTop: 12,
            }}
          >
            BACKLINKS
          </div>
          {links.incoming.map((l) => (
            <LinkRow key={l.id} link={l} relPath={active} />
          ))}
        </>
      )}
    </div>
  );
}
