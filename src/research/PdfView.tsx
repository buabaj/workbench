import { invoke } from "@tauri-apps/api/core";
import { MessageSquarePlus, PenLine, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
// The LEGACY build, deliberately.
//
// The modern bundle calls `Map.prototype.getOrInsertComputed` — a TC39
// proposal method — inside `page.render()`. WebKit does not have it, so every
// render threw synchronously and the page stayed blank. The legacy build is
// transpiled and ships the core-js polyfills, which is also why the same code
// rendered perfectly when driven headlessly under Node against the legacy
// entry point and never in the app.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { findQuoteSpans, type Annotation } from "./annotations";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
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
 * Collect a page's text items, without async iteration.
 *
 * `page.getTextContent()` is the obvious call and cannot be used: internally
 * it does `for await (const value of readableStream)`, and WebKit does not
 * implement `ReadableStream[Symbol.asyncIterator]`. It therefore rejects
 * before any of our code runs — which is why the failure looked like a bug in
 * our own `for...of` and why it never reproduced under Node, whose streams are
 * async-iterable.
 *
 * A reader does the same job with an API that exists everywhere.
 */
async function readTextItems(page: pdfjs.PDFPageProxy): Promise<unknown[]> {
  const reader = page.streamTextContent().getReader();
  const items: unknown[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.items) items.push(...value.items);
  }
  return items;
}

/**
 * Position the selectable text over a rendered page.
 *
 * Written here rather than using pdf.js's own `TextLayer`, which threw
 * "undefined is not a function" inside its render loop on this WebKit — the
 * same class of engine-support problem that stopped the canvas rendering. The
 * maths is short and standard, and doing it here means the one thing that
 * makes a PDF quotable does not depend on a DOM helper's assumptions.
 *
 * Each item carries a PDF-space transform. Composed with the viewport's, it
 * gives the glyph run's position and size on screen; the span is then squeezed
 * horizontally to match the run's measured width, so selection follows the
 * real characters rather than whatever the fallback font would do.
 */
function buildTextLayer(
  host: HTMLDivElement,
  rawItems: unknown[],
  viewport: { transform: number[]; width: number; height: number },
): void {
  host.replaceChildren();
  const frag = document.createDocumentFragment();

  for (const raw of rawItems) {
    const item = raw as {
      str?: string;
      transform?: number[];
      width?: number;
      height?: number;
      fontName?: string;
    };
    // Marked-content items have no `str`; they carry structure, not text.
    if (typeof item.str !== "string" || item.str.length === 0) continue;
    if (!item.transform) continue;

    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    // The vertical scale of the composed matrix is the on-screen font size.
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (fontHeight <= 0) continue;

    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.position = "absolute";
    span.style.whiteSpace = "pre";
    span.style.transformOrigin = "0% 0%";
    span.style.left = `${tx[4]}px`;
    // tx[5] is the baseline; the box starts a font-height above it.
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = "sans-serif";
    frag.append(span);
  }
  host.append(frag);

  // Match each span's rendered width to the run's real width, so the selection
  // rectangle lands on the glyphs beneath rather than drifting along the line.
  const items = rawItems as Array<{ str?: string; width?: number; transform?: number[] }>;
  let i = 0;
  for (const el of Array.from(host.children) as HTMLElement[]) {
    while (i < items.length && (!items[i].str || !items[i].transform)) i++;
    const item = items[i++];
    if (!item?.width) continue;
    const target = Math.abs(item.width) * Math.hypot(viewport.transform[0], viewport.transform[1]);
    const actual = el.getBoundingClientRect().width;
    if (actual > 0 && target > 0) {
      el.style.transform = `scaleX(${target / actual})`;
    }
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
  annotations,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onSelect: (sel: PdfSelection | null) => void;
  annotations: Annotation[];
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
  const [items, setItems] = useState<unknown[]>([]);
  const [openMark, setOpenMark] = useState<number | null>(null);
  /** Where each annotation's passage sits, in page coordinates. */
  const [boxes, setBoxes] = useState<Array<{ i: number; rects: Rect[] }>>([]);

  // Measured from the live DOM rather than computed from the text items,
  // because pdf.js positions text-layer runs with transforms and a run's
  // offsetWidth does not describe where it actually appears. Re-measured
  // whenever the layer is rebuilt or the zoom changes.
  useEffect(() => {
    const host = hostRef.current;
    const layer = textRef.current;
    if (!host || !layer || items.length === 0 || annotations.length === 0) {
      setBoxes([]);
      return;
    }
    const origin = host.getBoundingClientRect();
    const measured = annotations.map((a, i) => {
      const span = findQuoteSpans(items as Array<{ str?: string }>, a.quote);
      if (!span) return { i, rects: [] as Rect[] };
      const rects: Rect[] = [];
      for (let k = span.from; k <= span.to; k++) {
        const el = layer.children[k] as HTMLElement | undefined;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 0.5 || r.height < 0.5) continue;
        rects.push({
          left: r.left - origin.left,
          top: r.top - origin.top,
          width: r.width,
          height: r.height,
        });
      }
      return { i, rects };
    });
    setBoxes(measured.filter((m) => m.rects.length > 0));
  }, [items, annotations, scale]);

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
      if (!canvas) {
        return;
      }

      // Render at device resolution and scale down in CSS, or text is soft on
      // a Retina display. The dpr goes through `transform` rather than a
      // setTransform on the context, because pdf.js owns that context when it
      // is handed the canvas and would reset anything set behind its back.
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      // `render()` itself is inside the try, not just its promise. It can
      // throw synchronously, and when it did the exception escaped as an
      // unhandled rejection — no error, no page, nothing in any log.
      try {
        task = page.render({
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
          background: "#ffffff",
        });
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

      // Report what happened, always.
      //
      // The previous round reported only when nothing was drawn — and nothing
      // appeared, which means ink WAS found and the page still looked white.
      // That separates "pdf.js did not paint" from "the paint is not visible",
      // and only the second is left. The badge is unconditional so the answer
      // arrives whether or not the guess is right this time.
      setRenderErr(null);

      // Text layer: real DOM text, transparent, aligned over the canvas.
      // Its failure must not blank the page — the page is already drawn, and
      // losing selection is a smaller loss than losing the document.
      try {
        const textHost = textRef.current;
        if (textHost) {
          const textItems = await readTextItems(page);
          if (cancelled) return;
          buildTextLayer(textHost, textItems, viewport);
          setItems(textItems);
        }
      } catch (e) {
      }
    })();

    return () => {
      // Traced because a silent cancel and a hang look identical in a log
      // that only records success.
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
      <canvas ref={canvasRef} style={{ display: "block", position: "relative", zIndex: 1 }} />
      {/* The passage itself, tinted — not a marker in the margin.
          `multiply` over the white page reads like a highlighter rather than a
          coloured box sitting on top of the words, and keeps the text legible
          through it. Above the canvas, below the text layer, so selecting
          still works straight through a highlight. */}
      {boxes.map(({ i, rects }) => (
        <div key={i}>
          {rects.map((r, k) => (
            <button
              key={k}
              className={`pdf-highlight ${openMark === i ? "on" : ""}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              aria-label={`Note on “${annotations[i].quote.slice(0, 40)}”`}
              aria-expanded={openMark === i}
              onClick={(e) => {
                e.stopPropagation();
                setOpenMark(openMark === i ? null : i);
              }}
            />
          ))}
          {openMark === i && (
            <div
              className="pdf-note"
              role="note"
              // Below the passage, and pinned inside the page: a note on the
              // right-hand column would otherwise hang off the edge.
              style={{
                top: rects[0].top + rects[0].height + 6,
                left: Math.max(8, Math.min(rects[0].left, (size?.w ?? 600) - 340)),
              }}
            >
              <div className="pdf-note-quote">
                “{annotations[i].quote}”
              </div>
              <div className="pdf-note-body">{annotations[i].comment}</div>
              <button
                className="btn small"
                onClick={() => setOpenMark(null)}
                style={{ marginTop: 8 }}
              >
                Close
              </button>
            </div>
          )}
        </div>
      ))}

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
          // Explicitly above the canvas and explicitly transparent. An
          // absolutely-positioned sibling with no z-index paints after the
          // canvas, so anything opaque in it would hide a perfectly good page.
          zIndex: 2,
          background: "transparent",
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
  annotations = [],
}: {
  workspaceId: string;
  relPath: string;
  /** Offered when the host can store a note against the document. */
  onAnnotate?: (sel: PdfSelection) => void;
  /** Shown as markers beside the passages they were made on. */
  annotations?: Annotation[];
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
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          window.clearTimeout(timer);
          setErr(msg);
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
    // `flex: 1` rather than `height: 100%`: as a flex item in a column whose
    // height is not definite, a percentage height resolves to auto and the
    // whole reader collapses to nothing — which looks exactly like a blank
    // page and is not one.
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        height: "100%",
        position: "relative",
      }}
    >
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
            <Page
              key={i + 1}
              doc={doc}
              pageNumber={i + 1}
              scale={scale}
              onSelect={setSel}
              annotations={annotations.filter((a) => a.page === i + 1)}
            />
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
