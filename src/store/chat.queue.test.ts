import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Queuing prompts typed while a turn is running.
 *
 * The traps here are ordering (a drain that re-queues never empties) and
 * templates (composing at drain time gives every queued item the last mode you
 * picked, so `/explain this` then `/plan that` runs as two plans).
 */
const sent: Array<{ command: string; message: string; images?: unknown[] }> = [];

vi.mock("../ipc/client", () => ({
  formatError: (e: unknown) => String(e),
  ipc: {
    agentSend: vi.fn(async (_id: string, command: string, message: string, images?: unknown[]) => {
      sent.push({ command, message, images });
    }),
    chatAppendTurn: vi.fn(async () => {}),
    chatTitle: vi.fn(async () => "title"),
    agentStopTask: vi.fn(async () => {}),
    chatDeleteSession: vi.fn(async () => {}),
    chatTurns: vi.fn(async () => []),
    profilesResolve: vi.fn(async () => null),
    attachmentRead: vi.fn(async () => ({ base64: "AAAA", mimeType: "image/png", size: 4 })),
  },
}));

import { reduce, useChat } from "./chat";
import { findTemplate } from "../commands/prompts";

const WS = "ws-1";

/** Put the store in the state it is in mid-turn, with a live agent. */
function busyWithAgent() {
  useChat.setState({
    taskId: "task-1",
    workspaceId: WS,
    workspaceRoot: "/w",
    status: "streaming",
    phase: "thinking",
    turns: [],
    queue: [],
    queuePaused: false,
    mode: null,
    oneShot: null,
  });
}

/** Drive the reducer with the event the agent emits when a turn completes. */
function finishTurn() {
  reduce({ kind: "event", type: "agent_end" } as never, useChat.setState, useChat.getState);
}

beforeEach(() => {
  sent.length = 0;
  useChat.setState({
    taskId: null,
    workspaceId: null,
    workspaceRoot: null,
    turns: [],
    status: "idle",
    phase: "idle",
    mode: null,
    oneShot: null,
    queue: [],
    queuePaused: false,
  });
});

describe("queuing while a turn runs", () => {
  it("queues instead of sending, and does not touch the running turn", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "second thing");

    expect(sent).toHaveLength(0);
    expect(useChat.getState().queue.map((q) => q.text)).toEqual(["second thing"]);
    // The running turn's transcript is untouched.
    expect(useChat.getState().turns).toHaveLength(0);
  });

  it("sends immediately when nothing is running", async () => {
    useChat.setState({ taskId: "task-1", workspaceId: WS, status: "awaiting-input" });
    await useChat.getState().send(WS, "go now");

    expect(sent).toHaveLength(1);
    expect(sent[0].command).toBe("follow_up");
    expect(sent[0].message).toContain("go now");
    expect(useChat.getState().queue).toHaveLength(0);
  });

  it("keeps several in the order they were typed", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "first");
    await useChat.getState().send(WS, "second");
    await useChat.getState().send(WS, "third");
    expect(useChat.getState().queue.map((q) => q.text)).toEqual(["first", "second", "third"]);
  });
});

describe("each queued item keeps its own mode and command", () => {
  it("does not give every item the last template picked", async () => {
    busyWithAgent();

    // /explain is a one-shot command; /plan is a sticky mode.
    useChat.setState({ oneShot: findTemplate("explain") ?? null });
    await useChat.getState().send(WS, "this bit");

    useChat.setState({ mode: findTemplate("plan") ?? null });
    await useChat.getState().send(WS, "that bit");

    const [a, b] = useChat.getState().queue;
    expect(a.oneShot?.name).toBe("explain");
    expect(a.mode).toBeNull();
    expect(b.mode?.name).toBe("plan");
  });

  it("clears the one-shot on queuing, so the next item does not inherit it", async () => {
    busyWithAgent();
    useChat.setState({ oneShot: findTemplate("explain") ?? null });

    await useChat.getState().send(WS, "first");
    expect(useChat.getState().oneShot).toBeNull();

    await useChat.getState().send(WS, "second");
    expect(useChat.getState().queue[1].oneShot).toBeNull();
  });

  it("applies a sticky mode to everything queued after it was set", async () => {
    busyWithAgent();
    useChat.setState({ mode: findTemplate("understand") ?? null });
    await useChat.getState().send(WS, "one");
    await useChat.getState().send(WS, "two");
    expect(useChat.getState().queue.every((q) => q.mode?.name === "understand")).toBe(true);
  });

  it("composes a drained item with ITS template, not the current one", async () => {
    busyWithAgent();
    useChat.setState({ oneShot: findTemplate("explain") ?? null });
    await useChat.getState().send(WS, "the queued thing");

    // The mode changes while it waits — the queued item must not pick this up.
    useChat.setState({ mode: findTemplate("plan") ?? null, status: "awaiting-input" });
    useChat.getState().resumeQueue();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0].message).toContain("Explain the following");
    expect(sent[0].message).not.toContain("You are in PLAN MODE");
  });
});

describe("editing and removing before it starts", () => {
  it("edits only the item asked for", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "first");
    await useChat.getState().send(WS, "second");

    const target = useChat.getState().queue[1].id;
    useChat.getState().editQueued(target, "second, revised");

    expect(useChat.getState().queue.map((q) => q.text)).toEqual(["first", "second, revised"]);
  });

  it("sends the edited text, not the original", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "original");
    useChat.getState().editQueued(useChat.getState().queue[0].id, "revised");

    useChat.setState({ status: "awaiting-input" });
    useChat.getState().resumeQueue();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message).toContain("revised");
    expect(sent[0].message).not.toContain("original");
  });

  it("removes only the item asked for", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "keep");
    await useChat.getState().send(WS, "drop");
    useChat.getState().removeQueued(useChat.getState().queue[1].id);
    expect(useChat.getState().queue.map((q) => q.text)).toEqual(["keep"]);
  });

  it("changes one item's templates without touching the others", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "one");
    await useChat.getState().send(WS, "two");

    const id = useChat.getState().queue[0].id;
    useChat.getState().setQueuedTemplates(id, findTemplate("plan") ?? null, null);

    expect(useChat.getState().queue[0].mode?.name).toBe("plan");
    expect(useChat.getState().queue[1].mode).toBeNull();
  });
});

describe("draining when the agent finishes", () => {
  it("sends the queued prompt on agent_end, exactly once", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "the next thing");

    finishTurn();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message).toContain("the next thing");
    expect(useChat.getState().queue).toHaveLength(0);

    // A second completion with nothing queued must not resend.
    finishTurn();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
  });

  it("runs two in order, the second only after the first finishes", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "first");
    await useChat.getState().send(WS, "second");

    finishTurn();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message).toContain("first");
    // The first is now in flight; the second is still waiting.
    expect(useChat.getState().queue.map((q) => q.text)).toEqual(["second"]);

    finishTurn();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].message).toContain("second");
  });

  it("does not drain a queue that failed", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "queued");
    useChat.setState({ queuePaused: true });

    finishTurn();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
    expect(useChat.getState().queue).toHaveLength(1);
  });
});

describe("a paused queue", () => {
  it("does not drain while paused", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "queued");
    useChat.setState({ status: "awaiting-input", queuePaused: true });

    // Nothing should go out until it is resumed.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(0);
    expect(useChat.getState().queue).toHaveLength(1);
  });

  it("sends the head on resume", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "queued");
    useChat.setState({ status: "awaiting-input", queuePaused: true });

    useChat.getState().resumeQueue();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].message).toContain("queued");
    expect(useChat.getState().queue).toHaveLength(0);
  });

  it("is lifted by queuing something new, which reads as intent to continue", async () => {
    useChat.setState({ ...useChat.getState(), status: "streaming", queuePaused: true, workspaceId: WS });
    await useChat.getState().send(WS, "another");
    expect(useChat.getState().queuePaused).toBe(false);
  });
});

describe("the queue belongs to its conversation", () => {
  it("is cleared by starting a new one", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "queued");
    await useChat.getState().newConversation();
    expect(useChat.getState().queue).toEqual([]);
    expect(useChat.getState().queuePaused).toBe(false);
  });

  it("is cleared by opening a different conversation", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "queued");
    await useChat.getState().loadSession("other-task");
    expect(useChat.getState().queue).toEqual([]);
  });
});

describe("attachments belong to the queued item that carried them", () => {
  const img = { path: "/w/shot.png", name: "shot.png", kind: "image" as const, size: 10 };
  const log = { path: "/w/run.log", name: "run.log", kind: "file" as const, size: 10 };

  it("does not give a queued prompt the attachments of a later one", async () => {
    // The same trap as templates: composing at drain time would hand every
    // queued item whatever happened to be attached last.
    busyWithAgent();
    await useChat.getState().send(WS, "look at this", "/w", [img]);
    await useChat.getState().send(WS, "and this log", "/w", [log]);

    const [a, b] = useChat.getState().queue;
    expect(a.attachments.map((x) => x.name)).toEqual(["shot.png"]);
    expect(b.attachments.map((x) => x.name)).toEqual(["run.log"]);
  });

  it("sends each queued item with its own attachments when it drains", async () => {
    busyWithAgent();
    await useChat.getState().send(WS, "the image one", "/w", [img]);
    await useChat.getState().send(WS, "the file one", "/w", [log]);

    finishTurn();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The image went as bytes, and no path footer names it.
    expect(sent[0].images).toHaveLength(1);
    expect(sent[0].message).not.toContain("/w/shot.png");

    finishTurn();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // The file went as a path, with no image payload.
    expect(sent[1].images).toHaveLength(0);
    expect(sent[1].message).toContain("/w/run.log");
  });

  it("keeps the transcript showing what was attached", async () => {
    useChat.setState({ taskId: "task-1", workspaceId: WS, status: "awaiting-input" });
    await useChat.getState().send(WS, "here", "/w", [img]);

    const userTurn = useChat.getState().turns.find((t) => t.role === "user");
    expect(userTurn?.attachments?.map((a) => a.name)).toEqual(["shot.png"]);
    // Bytes are not kept on the turn — the file is still on disk.
    expect(userTurn?.attachments?.[0]).not.toHaveProperty("data");
  });

  it("sends an attachment with no text at all", async () => {
    // Dropping a screenshot and pressing return is a clear enough request.
    useChat.setState({ taskId: "task-1", workspaceId: WS, status: "awaiting-input" });
    await useChat.getState().send(WS, "", "/w", [img]);

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].images).toHaveLength(1);
  });
});
