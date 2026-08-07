import { useEffect } from "react";
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
  useEffect(() => {
    // Any click, scroll, or Escape dismisses. Capture phase, so a click that
    // lands on something else closes this first rather than after acting.
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onDown, true);
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
