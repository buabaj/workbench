import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The half of the quit guard that decides whether work is lost.
 *
 * Worth testing on its own because the backend half is unverifiable from a test
 * — it depends on which events macOS actually delivers, and the first version of
 * this guard was dead code for exactly that reason. What *is* testable is the
 * contract: a clean app must quit without asking, a dirty one must ask and must
 * tell the backend it is asking, or the 3-second backstop kills the dialog and
 * the unsaved work with it.
 */
const emit = { fire: undefined as undefined | (() => void) };
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: () => void) => {
    emit.fire = cb;
    return unlisten;
  }),
}));

const confirmQuit = vi.fn(async () => {});
const quitAck = vi.fn(async () => {});

vi.mock("../ipc/client", () => ({
  formatError: (e: unknown) => String(e),
  ipc: {
    confirmQuit: () => confirmQuit(),
    quitAck: () => quitAck(),
  },
}));

const saveBuffer = vi.fn(async (): Promise<"saved" | "conflict"> => "saved");

vi.mock("../store/workspace", () => ({
  saveBuffer: (...args: unknown[]) => saveBuffer(...(args as [])),
  useWorkspace: { getState: () => ({ buffers: state.buffers }) },
}));

vi.mock("../editor/editorRegistry", () => ({
  editorRegistry: {
    liveView: () => undefined,
    get: () => ({ state: { doc: { toString: () => "saved text" } } }),
  },
}));

const state: { buffers: Record<string, { relPath: string; phase: string }> } = { buffers: {} };

import { QuitGuard } from "./QuitGuard";

/** Mount, then deliver the event the backend emits while holding the exit. */
async function quitPressed() {
  render(<QuitGuard />);
  await waitFor(() => expect(emit.fire).toBeDefined());
  emit.fire!();
}

function dirty(...paths: string[]) {
  state.buffers = Object.fromEntries(paths.map((p) => [p, { relPath: p, phase: "dirty" }]));
}

beforeEach(() => {
  state.buffers = {};
  emit.fire = undefined;
  confirmQuit.mockClear();
  quitAck.mockClear();
  saveBuffer.mockClear();
  saveBuffer.mockImplementation(async () => "saved");
});
afterEach(cleanup);

describe("with nothing unsaved", () => {
  it("quits without asking", async () => {
    state.buffers = { "a.ts": { relPath: "a.ts", phase: "clean" } };
    await quitPressed();

    await waitFor(() => expect(confirmQuit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nothing to ask about, so nothing to hold the exit for.
    expect(quitAck).not.toHaveBeenCalled();
  });
});

describe("with unsaved work", () => {
  it("asks, and does not quit on its own", async () => {
    dirty("notes/draft.md");
    await quitPressed();

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("notes/draft.md")).toBeTruthy();
    expect(confirmQuit).not.toHaveBeenCalled();
  });

  it("acks so the backstop does not quit out from under the dialog", async () => {
    dirty("a.md");
    await quitPressed();
    await waitFor(() => expect(quitAck).toHaveBeenCalledTimes(1));
  });

  it("counts a conflicted buffer as unsaved too", async () => {
    state.buffers = { "a.md": { relPath: "a.md", phase: "conflict" } };
    await quitPressed();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("keeps working: dismisses without quitting, and asks again next time", async () => {
    dirty("a.md");
    await quitPressed();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    screen.getByRole("button", { name: "Keep working" }).click();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(confirmQuit).not.toHaveBeenCalled();

    // A dismissed prompt must not disarm the next one.
    emit.fire!();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("quits without saving when that is chosen", async () => {
    dirty("a.md");
    await quitPressed();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    screen.getByRole("button", { name: "Quit without saving" }).click();
    await waitFor(() => expect(confirmQuit).toHaveBeenCalledTimes(1));
    expect(saveBuffer).not.toHaveBeenCalled();
  });

  it("saves every dirty buffer before quitting", async () => {
    dirty("a.md", "b.md", "c.md");
    await quitPressed();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    screen.getByRole("button", { name: "Save all and quit" }).click();
    await waitFor(() => expect(confirmQuit).toHaveBeenCalledTimes(1));
    expect(saveBuffer).toHaveBeenCalledTimes(3);
  });

  it("does not quit when a save hits a conflict", async () => {
    dirty("a.md");
    saveBuffer.mockImplementation(async () => "conflict");
    await quitPressed();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    screen.getByRole("button", { name: "Save all and quit" }).click();
    // Quitting here would discard the very change the conflict is about.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(confirmQuit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
