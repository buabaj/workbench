import { Channel, invoke } from "@tauri-apps/api/core";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, WholeWord } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatError,
  type SearchMatch,
  type SearchProgress,
  type SearchQuery,
  ipc,
} from "../ipc/client";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";

/**
 * Find in files, and replace across them.
 *
 * Results stream in and are grouped by file. Replace acts on the files shown,
 * not on a fresh search, so what you confirm is what you were looking at.
 */

/** Wait for typing to settle before searching a whole tree. */
const DEBOUNCE_MS = 220;

function Highlight({ m }: { m: SearchMatch }) {
  // Offsets are byte-based from Rust; for the ASCII-dominant case they line up
  // with JS indices, and a mismatch degrades to showing the plain line rather
  // than mis-slicing it.
  const safe = m.start <= m.end && m.end <= m.text.length;
  if (!safe) return <>{m.text.trim()}</>;
  return (
    <>
      {m.text.slice(0, m.start).trimStart()}
      <mark
        style={{
          background: "var(--clay-wash)",
          color: "var(--clay-text)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {m.text.slice(m.start, m.end)}
      </mark>
      {m.text.slice(m.end).trimEnd()}
    </>
  );
}

function Toggle({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className="btn icon"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      style={{
        padding: 3,
        color: on ? "var(--clay-text)" : "var(--ink-faint)",
        background: on ? "var(--clay-wash)" : undefined,
      }}
    >
      {children}
    </button>
  );
}

export function SearchPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const openFileTab = useLayout((s) => s.openFileTab);

  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  // Identifies the search a channel belongs to, so results from a superseded
  // query cannot land in the list after a newer one has started.
  const runId = useRef(0);

  const query: SearchQuery = useMemo(
    () => ({ pattern, caseSensitive, wholeWord, regex }),
    [pattern, caseSensitive, wholeWord, regex],
  );

  useEffect(() => {
    if (!workspace) return;
    const mine = ++runId.current;
    if (!pattern.trim()) {
      setMatches([]);
      setBusy(false);
      setTruncated(false);
      setErr(null);
      return;
    }

    const timer = window.setTimeout(() => {
      setBusy(true);
      setErr(null);
      setMatches([]);
      setTruncated(false);

      const channel = new Channel<SearchProgress>();
      channel.onmessage = (p) => {
        if (runId.current !== mine) return; // superseded
        if (p.matches.length) setMatches((prev) => prev.concat(p.matches));
        if (p.truncated) setTruncated(true);
        if (p.done) setBusy(false);
      };

      void invoke("search_run", { workspaceId: workspace.id, query, channel }).catch((e) => {
        if (runId.current !== mine) return;
        setErr(formatError(e));
        setBusy(false);
      });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [workspace?.id, pattern, caseSensitive, wholeWord, regex]);

  const byFile = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of matches) {
      const list = map.get(m.relPath);
      if (list) list.push(m);
      else map.set(m.relPath, [m]);
    }
    return [...map.entries()];
  }, [matches]);

  const doReplace = async () => {
    if (!workspace || byFile.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await ipc.searchReplace(
        workspace.id,
        query,
        replacement,
        byFile.map(([file]) => file),
      );
      setNote(
        `Replaced ${out.replacements} in ${out.filesChanged} file${out.filesChanged === 1 ? "" : "s"}.`,
      );
      // Re-run so the list reflects the file as it now is.
      setPattern((p) => p);
      runId.current++;
      setMatches([]);
      window.setTimeout(() => setNote(null), 4000);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  // Open the file AND put the cursor on the match: a result you have to hunt
  // for once the file opens is only half an answer.
  const reveal = (m: SearchMatch) => {
    useWorkspace.getState().revealLine(m.relPath, m.line, m.start, m.end);
    openFileTab(m.relPath);
  };

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          className="btn icon"
          aria-label={showReplace ? "Hide replace" : "Show replace"}
          aria-expanded={showReplace}
          title="Replace"
          onClick={() => setShowReplace((v) => !v)}
          style={{ padding: 3, color: showReplace ? "var(--clay-text)" : "var(--ink-faint)" }}
        >
          <Replace size={13} strokeWidth={1.7} />
        </button>
        <input
          className="field"
          style={{ flex: 1, fontSize: "var(--text-sm)", padding: "3px 6px" }}
          placeholder="Find in files"
          aria-label="Search pattern"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", gap: 2, paddingLeft: 26 }}>
        <Toggle on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} label="Match case">
          <CaseSensitive size={13} strokeWidth={1.7} />
        </Toggle>
        <Toggle on={wholeWord} onClick={() => setWholeWord((v) => !v)} label="Whole word">
          <WholeWord size={13} strokeWidth={1.7} />
        </Toggle>
        <Toggle on={regex} onClick={() => setRegex((v) => !v)} label="Regular expression">
          <Regex size={13} strokeWidth={1.7} />
        </Toggle>
      </div>

      {showReplace && (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ width: 22 }} />
          <input
            className="field"
            style={{ flex: 1, fontSize: "var(--text-sm)", padding: "3px 6px" }}
            placeholder={regex ? "Replace with (use $1 for groups)" : "Replace with"}
            aria-label="Replacement text"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button
            className="btn"
            style={{ fontSize: "var(--text-xs)" }}
            disabled={busy || byFile.length === 0}
            onClick={() => void doReplace()}
            title={`Replace in ${byFile.length} file${byFile.length === 1 ? "" : "s"}`}
          >
            All
          </button>
        </div>
      )}

      {err && (
        <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>
          {err}
        </div>
      )}
      {note && (
        <div role="status" style={{ color: "var(--clay-text)", fontSize: "var(--text-xs)" }}>
          {note}
        </div>
      )}

      {pattern.trim() && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
          {busy
            ? "Searching…"
            : matches.length === 0
              ? "No results"
              : `${matches.length} in ${byFile.length} file${byFile.length === 1 ? "" : "s"}`}
          {truncated && " (stopped at 5000)"}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {byFile.map(([file, hits]) => {
          const isCollapsed = collapsed.has(file);
          return (
            <div key={file}>
              <div
                className="rail-item"
                role="button"
                tabIndex={0}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(file)) next.delete(file);
                    else next.add(file);
                    return next;
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).click();
                  }
                }}
                title={file}
              >
                <span className="twisty" aria-hidden>
                  {isCollapsed ? (
                    <ChevronRight size={12} strokeWidth={2} />
                  ) : (
                    <ChevronDown size={12} strokeWidth={2} />
                  )}
                </span>
                <span className="label">{file}</span>
                <span className="count">{hits.length}</span>
              </div>
              {!isCollapsed &&
                hits.map((m, i) => (
                  <div
                    key={`${m.line}:${m.start}:${i}`}
                    className="rail-item"
                    role="button"
                    tabIndex={0}
                    style={{ paddingLeft: 26, fontFamily: "var(--mono)", fontSize: "var(--text-xs)" }}
                    onClick={() => reveal(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        reveal(m);
                      }
                    }}
                    title={`${m.relPath}:${m.line}`}
                  >
                    <span style={{ color: "var(--ink-faint)", minWidth: 30, textAlign: "right" }}>
                      {m.line}
                    </span>
                    <span
                      className="label"
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      <Highlight m={m} />
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
