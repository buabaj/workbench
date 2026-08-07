import { BookPlus, Check, ExternalLink, FileDown, Search as SearchIcon } from "lucide-react";
import { useState } from "react";
import { formatError, ipc, type Paper } from "../ipc/client";
import { useLayout } from "../store/layout";
import { useWorkspace } from "../store/workspace";

/**
 * Scholarly search, and the door into the library.
 *
 * Importing writes a markdown note with YAML frontmatter into `papers/`, and
 * fetches the open-access PDF beside it where there is one. Nothing is stored
 * in a private database: the library is files, so it is searchable, linkable,
 * readable by the agent, and still there if this app is not.
 */
function Result({
  paper,
  onImport,
  state,
}: {
  paper: Paper;
  onImport: () => void;
  state: "idle" | "busy" | "done" | "had-it";
}) {
  return (
    <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-sm)",
            color: "var(--ink)",
            lineHeight: 1.35,
          }}
        >
          {paper.title}
        </span>
        <button
          className="btn icon"
          aria-label={state === "done" ? "In your library" : `Add ${paper.title} to library`}
          title={
            state === "had-it"
              ? "Already in your library"
              : state === "done"
                ? "Added"
                : "Add to library"
          }
          disabled={state === "busy" || state === "done" || state === "had-it"}
          onClick={onImport}
          style={{
            padding: 3,
            flexShrink: 0,
            color: state === "done" || state === "had-it" ? "var(--diff-add)" : "var(--ink-faint)",
          }}
        >
          {state === "done" || state === "had-it" ? (
            <Check size={13} strokeWidth={2} />
          ) : (
            <BookPlus size={13} strokeWidth={1.7} />
          )}
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "baseline",
          flexWrap: "wrap",
          marginTop: 2,
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
        }}
      >
        {paper.authors.length > 0 && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>
            {paper.authors[0]}
            {paper.authors.length > 1 && ` +${paper.authors.length - 1}`}
          </span>
        )}
        {paper.year != null && <span>{paper.year}</span>}
        {paper.citedBy > 0 && <span>{paper.citedBy.toLocaleString()} cited</span>}
        {/* Open access is the difference between a library you can read
            offline and a list of links, so it is worth its own marker. */}
        {paper.openAccess && (
          <span style={{ color: "var(--clay-text)", display: "inline-flex", alignItems: "center", gap: 2 }}>
            <FileDown size={10} strokeWidth={2} /> PDF
          </span>
        )}
        {paper.landingUrl && (
          <a
            href={paper.landingUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ink-faint)", display: "inline-flex", alignItems: "center", gap: 2 }}
            title={paper.landingUrl}
          >
            <ExternalLink size={10} strokeWidth={2} /> source
          </a>
        )}
      </div>
    </div>
  );
}

export function LibraryPanel() {
  const workspace = useWorkspace((s) => s.workspace);
  const openFileTab = useLayout((s) => s.openFileTab);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Paper[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, "idle" | "busy" | "done" | "had-it">>({});
  const [searched, setSearched] = useState(false);

  // Explicit submit, not debounced-as-you-type: this is a network call to
  // someone else's index, and firing one per keystroke would be rude and slow.
  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResults(await ipc.scholarSearch(query, 20));
      setSearched(true);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const importPaper = async (paper: Paper) => {
    if (!workspace) return;
    setStates((s) => ({ ...s, [paper.id]: "busy" }));
    try {
      const out = await ipc.paperImport(workspace.id, paper);
      setStates((s) => ({ ...s, [paper.id]: out.alreadyHadIt ? "had-it" : "done" }));
      openFileTab(out.relPath);
    } catch (e) {
      setErr(formatError(e));
      setStates((s) => ({ ...s, [paper.id]: "idle" }));
    }
  };

  if (!workspace) return <div className="panel-empty">Open a workspace.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          className="field"
          style={{ flex: 1, fontSize: "var(--text-sm)", padding: "3px 6px" }}
          placeholder="Search papers"
          aria-label="Search papers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button
          className="btn icon"
          aria-label="Search"
          title="Search"
          disabled={busy || !query.trim()}
          onClick={() => void run()}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <SearchIcon size={13} strokeWidth={1.7} />
        </button>
      </div>

      {err && (
        <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}>
          {err}
        </div>
      )}

      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
        {busy
          ? "Searching…"
          : searched
            ? results.length === 0
              ? "Nothing found"
              : `${results.length} results · added papers land in papers/`
            : "Papers you add become notes, with the PDF when it is open access."}
      </div>

      <div>
        {results.map((p) => (
          <Result
            key={p.id}
            paper={p}
            state={states[p.id] ?? "idle"}
            onImport={() => void importPaper(p)}
          />
        ))}
      </div>
    </div>
  );
}
