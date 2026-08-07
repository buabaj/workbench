import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * A PDF, rendered locally.
 *
 * pdf.js drawing to a canvas, rather than handing the file to the webview:
 * the app's CSP sets `object-src` and `frame-src` to `none`, so `<embed>` and
 * `<iframe>` — the usual ways to show a PDF — are both blocked. Relaxing that
 * to display a document would widen the app's attack surface for a feature
 * that does not need it.
 *
 * The worker is bundled, not fetched: `script-src 'self'` and there is no
 * network dependency in a library that is meant to work offline.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfView({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The LOADING TASK owns teardown — it tears down the worker too, which the
    // document proxy alone does not.
    let task: pdfjs.PDFDocumentLoadingTask | null = null;

    void (async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("file_read_bytes", { workspaceId, path: relPath });
        // pdf.js takes ownership of the buffer it is given, so it gets a copy —
        // otherwise re-rendering the same file after a detach throws.
        const data = new Uint8Array(bytes.slice(0));
        task = pdfjs.getDocument({ data });
        const loaded = await task.promise;
        if (cancelled) return;
        setDoc(loaded);
        setPage(1);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [workspaceId, relPath]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;

    void (async () => {
      const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled) return;
      const viewport = p.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      // Render at device resolution, then scale down in CSS, or text is soft
      // on a Retina display — which is most of the point of reading here.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      task = p.render({ canvas, canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* superseded by a newer render */
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, scale]);

  if (err) {
    return (
      <div role="alert" style={{ padding: "var(--s-4)", color: "var(--error)", fontSize: "var(--text-sm)" }}>
        Could not open this PDF: {err}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px var(--s-3)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <button
          className="btn icon"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
        </button>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", fontFamily: "var(--mono)" }}>
          {doc ? `${page} / ${doc.numPages}` : "…"}
        </span>
        <button
          className="btn icon"
          aria-label="Next page"
          disabled={!doc || page >= doc.numPages}
          onClick={() => setPage((p) => (doc ? Math.min(doc.numPages, p + 1) : p))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn icon"
          aria-label="Zoom out"
          onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ZoomOut size={14} strokeWidth={1.8} />
        </button>
        <button
          className="btn icon"
          aria-label="Zoom in"
          onClick={() => setScale((s) => Math.min(3, s + 0.2))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ZoomIn size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--s-4)", textAlign: "center" }}>
        <canvas ref={canvasRef} style={{ boxShadow: "var(--lift)", borderRadius: 2 }} />
      </div>
    </div>
  );
}
