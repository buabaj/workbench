import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seam between split terminals was reported missing twice, and reading the
 * markup did not explain why. These render the dock for real.
 *
 * xterm and the Tauri bridge are stubbed: neither works under jsdom, and
 * neither is what is under test here — the question is purely which elements
 * the dock puts on the page.
 */
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("pty-1"),
  Channel: class {
    onmessage: ((v: unknown) => void) | null = null;
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData() {
      return { dispose() {} };
    }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalDock } from "./TerminalDock";
import { useWorkspace } from "../store/workspace";

beforeEach(() => {
  // jsdom has no ResizeObserver; the dock observes its host to keep the pty
  // sized. A no-op stub is enough — resizing is not what these assert.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useWorkspace.setState({
    workspace: { id: "w1", name: "demo", rootPath: "/tmp/demo", kind: "git" },
  });
});
afterEach(cleanup);

const seams = (c: HTMLElement) => c.querySelectorAll(".term-split").length;

describe("TerminalDock", () => {
  it("starts with one shell and no split control", () => {
    render(<TerminalDock onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Terminal 1" })).toBeTruthy();
    // Nothing to split against yet.
    expect(screen.queryByRole("button", { name: /side by side/i })).toBeNull();
  });

  it("adds a shell, and only then offers to split", () => {
    render(<TerminalDock onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(screen.getByRole("button", { name: "Terminal 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /side by side/i })).toBeTruthy();
  });

  /** The reported bug: no visible divider between split panes. */
  it("puts a seam between panes when split, and none when tabbed", () => {
    const { container } = render(<TerminalDock onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(seams(container)).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /side by side/i }));
    expect(seams(container)).toBe(1);

    // A third shell means a second seam — one between each adjacent pair.
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(seams(container)).toBe(2);
  });

  it("closing the last shell closes the dock", () => {
    const onClose = vi.fn();
    render(<TerminalDock onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close terminal 1" }));
    expect(onClose).toHaveBeenCalled();
  });
});
