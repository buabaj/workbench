import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Right-click actions for a row in the file tree.
 *
 * A portal, so the menu is never clipped by the rail's overflow, and
 * positioned at the pointer rather than the row — that is where the eye
 * already is.
 */

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

export function FileContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Any click outside, scroll, or Escape dismisses.
    //
    // The "outside" test is load-bearing, not defensive: this listens in the
    // capture phase, so without it a mousedown ON a menu item closed the menu
    // and unmounted the button before the click could land — the item's
    // onClick never ran, and "Add to chat" silently did nothing.
    const onDown = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Scrolling always dismisses: the menu is pinned to a pointer position
    // that stops meaning anything once the page moves under it.
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep it on screen when opened near an edge.
  const width = 190;
  const height = items.length * 30 + 8;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        top,
        left,
        width,
        zIndex: 100,
        padding: 4,
        background: "var(--canvas)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-panel)",
        boxShadow: "var(--lift-strong)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className="btn quiet"
          style={{
            display: "flex",
            width: "100%",
            justifyContent: "flex-start",
            fontSize: "var(--text-sm)",
            padding: "5px 8px",
          }}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
