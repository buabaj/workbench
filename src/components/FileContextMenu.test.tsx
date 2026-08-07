import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContextMenu } from "./FileContextMenu";

afterEach(cleanup);

/**
 * The menu as it is actually used: `onClose` UNMOUNTS it. Rendering the menu
 * with an inert onClose hides the very bug this file exists to catch, because
 * the button survives a dismiss that would have removed it in the app.
 */
function Harness({ onSelect }: { onSelect: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <FileContextMenu
      x={10}
      y={10}
      items={[{ label: "Add to chat", onSelect }]}
      onClose={() => setOpen(false)}
    />
  );
}

/**
 * These exist because "right-click, Add to chat" silently did nothing, and
 * reading the code did not reveal why — the failure is in event ordering, not
 * in the handler.
 */
describe("FileContextMenu", () => {
  const open = (onSelect: () => void, onClose = () => {}) =>
    render(
      <FileContextMenu
        x={10}
        y={10}
        items={[{ label: "Add to chat", onSelect }]}
        onClose={onClose}
      />,
    );

  /**
   * The regression: the dismiss handler listened for mousedown on window in
   * the CAPTURE phase, so pressing the mouse over a menu item closed the menu
   * and unmounted the button before the click could land on it.
   */
  it("runs the action when an item is clicked", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const item = screen.getByRole("menuitem", { name: "Add to chat" });

    // A real click is mousedown then mouseup then click — not click alone.
    fireEvent.mouseDown(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("closes after acting, so the menu does not linger", () => {
    const onClose = vi.fn();
    open(() => {}, onClose);
    const item = screen.getByRole("menuitem", { name: "Add to chat" });
    fireEvent.mouseDown(item);
    fireEvent.click(item);
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on a click outside", () => {
    const onClose = vi.fn();
    open(() => {}, onClose);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape", () => {
    const onClose = vi.fn();
    open(() => {}, onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
