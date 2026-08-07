import { invoke } from "@tauri-apps/api/core";
import { MessageSquarePlus, PenLine, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useComposer } from "../store/composer";
import { useLayout } from "../store/layout";

/**
 * A PDF, rendered locally and read continuously.
 *
 * pdf.js drawing to canvases rather than handing the file to the webview: the
 * app's CSP sets `object-src` and `frame-src` to `none`, so `<embed>` and
 * `<iframe>` are both blocked, and relaxing that to display a document would
 * widen the attack surface for a feature that does not need it.
 *
 * Pages stack and scroll. A paged reader with next/previous is the wrong shape
 * for reading a paper — you move through an argument, not through pages — and
 * it makes a passage that straddles a page break impossible to select.
 *
 * Each page carries a real text layer, invisible but selectable, positioned
 * over its canvas. That is what makes a PDF quotable: without it a canvas is
 * a picture of words.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** A page is rendered when it comes near the viewport, not all at once. */
const RENDER_MARGIN = "600px";

/** Rendered without waiting to be observed, so the reader is never blank. */
const EAGER_PAGES = 3;

/**
 * Non-white pixels in a sample of the canvas.
 *
 * Sampled rather than scanned: a full readback of a 1500×2000 canvas per page
 * would cost more than the render. A page of text has ink in its middle band,
 * which is where this looks.
 */
function countInk(canvas: HTMLCanvasElement): number {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return -1; // no context at all is a different failure
    const w = Math.min(canvas.width, 400);
    const h = Math.min(canvas.height, 400);
    const x = Math.max(0, Math.floor((canvas.width - w) / 2));
    const y = Math.max(0, Math.floor(canvas.height * 0.25));
    const { data } = ctx.getImageData(x, y, w, h);
    let ink = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] > 8 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) ink++;
    }
    return ink;
  } catch {
    return -1; // tainted or unreadable; not worth failing the page over
  }
}

/** Loading must not hang silently: a black rectangle is not a state. */
const LOAD_TIMEOUT_MS = 30_000;

export interface PdfSelection {
  page: number;
  text: string;
}

function Page({
  doc,
  pageNumber,
  scale,
  onSelect,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onSelect: (sel: PdfSelection | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  // The first pages render unconditionally. Gating every page on an
  // IntersectionObserver made correctness depend on the observer firing, and
  // when it did not the reader showed a column of blank white rectangles with
  // no error — indistinguishable from a broken PDF.
  const [visible, setVisible] = useState(pageNumber <= EAGER_PAGES);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);

  // Reserve the page's space before it renders, so the scrollbar does not
  // lurch as pages fill in behind you.
  useEffect(() => {
    let live = true;
    void doc.getPage(pageNumber).then((p) => {
      if (!live) return;
      const v = p.getViewport({ scale });
      setSize({ w: v.width, h: v.height });
    });
    return () => {
      live = false;
    };
  }, [doc, pageNumber, scale]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)),
      { root: null, rootMargin: RENDER_MARGIN },
    );
    io.observe(host);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Render at device resolution and scale down in CSS, or text is soft on
      // a Retina display. The dpr goes through `transform` rather than a
      // setTransform on the context, because pdf.js owns that context when it
      // is handed the canvas and would reset anything set behind its back.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        background: "#ffffff",
      });
      try {
        await task.promise;
      } catch (e) {
        // A cancelled render is routine — the page was superseded. Anything
        // else has to be shown: swallowing it leaves a blank white page and
        // no way to tell why.
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled && !/cancel/i.test(msg)) setRenderErr(msg);
        return;
      }
      if (cancelled) return;

      // Verify something was actually drawn.
      //
      // Three attempts at this bug produced a blank page and no error, because
      // a render that completes without painting reports success. Sampling the
      // canvas turns "blank white" into a fact, and the numbers say which of
      // the remaining explanations it is.
      const ink = countInk(canvas);
      if (ink === 0) {
        setRenderErr(
          `rendered 0 visible pixels — canvas ${canvas.width}×${canvas.height}, ` +
            `viewport ${Math.round(viewport.width)}×${Math.round(viewport.height)}, dpr ${dpr}`,
        );
        return;
      }
      setRenderErr(null);

      // Text layer: real DOM text, transparent, aligned over the canvas.
      // Its failure must not blank the page — the page is already drawn, and
      // losing selection is a smaller loss than losing the document.
      try {
        const textHost = textRef.current;
        if (textHost) {
          textHost.replaceChildren();
          const layer = new pdfjs.TextLayer({
            textContentSource: await page.getTextContent(),
            container: textHost,
            viewport,
          });
          await layer.render();
        }
      } catch {
        /* selection unavailable on this page */
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale, visible]);

  return (
    <div
      ref={hostRef}
      data-page={pageNumber}
      onMouseUp={() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        onSelect(text ? { page: pageNumber, text } : null);
      }}
      style={{
        position: "relative",
        width: size ? size.w : undefined,
        height: size ? size.h : 400,
        margin: "0 auto var(--s-4)",
        background: "#ffffff",
        boxShadow: "var(--lift)",
        borderRadius: 2,
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {renderErr && (
        <div
          role="alert"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            padding: "var(--s-4)",
            color: "var(--error)",
            fontSize: "var(--text-xs)",
            textAlign: "center",
          }}
        >
          Page {pageNumber} failed to render: {renderErr}
        </div>
      )}
      <div
        ref={textRef}
        className="pdf-text-layer"
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          lineHeight: 1,
          // Full opacity with TRANSPARENT text, not a transparent layer: the
          // selection highlight is painted on the layer, so fading the layer
          // would fade the highlight along with it and selecting would look
          // like nothing happened.
        }}
      />
    </div>
  );
}

export function PdfView({
  workspaceId,
  relPath,
  onAnnotate,
}: {
  workspaceId: string;
  relPath: string;
  /** Offered when the host can store a note against the document. */
  onAnnotate?: (sel: PdfSelection) => void;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1.25);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<PdfSelection | null>(null);
  const append = useComposer((s) => s.appendAndFocus);
  const focusChat = useLayout((s) => s.focusChat);

  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setErr(null);

    // A viewer that renders nothing and says nothing is indistinguishable from
    // a broken one, so loading is bounded and failure is reported.
    const timer = window.setTimeout(() => {
      if (!cancelled) setErr("Timed out opening this PDF.");
    }, LOAD_TIMEOUT_MS);

    void (async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("file_read_bytes", { workspaceId, path: relPath });
        // pdf.js takes ownership of the buffer it is given, so it gets a copy.
        const data = new Uint8Array(bytes.slice(0));
        task = pdfjs.getDocument({ data });
        const loaded = await task.promise;
        if (cancelled) return;
        window.clearTimeout(timer);
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) {
          window.clearTimeout(timer);
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void task?.destroy();
    };
  }, [workspaceId, relPath]);

  const addToChat = useCallback(() => {
    if (!sel) return;
    // The quote goes in verbatim: unlike a code selection there is no line
    // range to point at, and the agent cannot open a PDF to look for itself.
    append(`From @${relPath} (p.${sel.page}):\n\n> ${sel.text.replace(/\n+/g, " ")}\n\n`);
    focusChat();
    setSel(null);
  }, [sel, relPath, append, focusChat]);

  if (err) {
    return (
      <div role="alert" style={{ padding: "var(--s-4)", color: "var(--error)", fontSize: "var(--text-sm)" }}>
        Could not open this PDF: {err}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }}>
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
        <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-muted)", fontFamily: "var(--mono)" }}>
          {doc ? `${doc.numPages} pages` : "opening…"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="btn icon"
          aria-label="Zoom out"
          onClick={() => setScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ZoomOut size={14} strokeWidth={1.8} />
        </button>
        <button
          className="btn icon"
          aria-label="Zoom in"
          onClick={() => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2)))}
          style={{ padding: 3, color: "var(--ink-faint)" }}
        >
          <ZoomIn size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--s-4)" }}>
        {!doc ? (
          <div style={{ color: "var(--ink-faint)", fontSize: "var(--text-sm)", textAlign: "center" }}>
            Opening…
          </div>
        ) : (
          Array.from({ length: doc.numPages }, (_, i) => (
            <Page key={i + 1} doc={doc} pageNumber={i + 1} scale={scale} onSelect={setSel} />
          ))
        )}
      </div>

      {sel && (
        <div
          role="toolbar"
          aria-label="Selection actions"
          // Pinned rather than following the selection: a PDF selection can
          // span pages, so there is no single place it belongs.
          style={{
            position: "absolute",
            bottom: "var(--s-4)",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            gap: 2,
            padding: 4,
            background: "var(--canvas)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-control)",
            boxShadow: "var(--lift-strong)",
            zIndex: 20,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className="btn"
            style={{ fontSize: "var(--text-xs)", padding: "4px 10px", gap: 5 }}
            onClick={addToChat}
          >
            <MessageSquarePlus size={12} strokeWidth={1.8} />
            Add to chat
          </button>
          {onAnnotate && (
            <button
              className="btn"
              style={{ fontSize: "var(--text-xs)", padding: "4px 10px", gap: 5 }}
              onClick={() => {
                onAnnotate(sel);
                setSel(null);
              }}
            >
              <PenLine size={12} strokeWidth={1.8} />
              Annotate
            </button>
          )}
        </div>
      )}
    </div>
  );
}
