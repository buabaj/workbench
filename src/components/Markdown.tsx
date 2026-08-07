import { useMemo } from "react";
import { marked } from "marked";

/**
 * Shared Markdown renderer for chat replies and the file preview.
 *
 * Raw HTML is escaped before parsing rather than passed through: this content
 * comes from a model or a repo, and the webview shares an origin with the IPC
 * bridge. Escaping removes the injection surface without a sanitiser dep.
 */
export function Markdown({ source, className = "md" }: { source: string; className?: string }) {
  const html = useMemo(() => {
    const escaped = source.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return marked.parse(escaped, { async: false, gfm: true, breaks: true }) as string;
  }, [source]);

  // eslint-disable-next-line react/no-danger -- HTML escaped above
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
