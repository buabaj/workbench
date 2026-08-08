import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  describeMessage,
  extractDelta,
  summarizeToolArgs,
  toolResultText,
} from "../chat/normalize";
import { referenceFooter } from "../chat/mentions";
import { composeMessage, type PromptTemplate } from "../commands/prompts";
import {
  formatError,
  ipc,
  type ResolvedAgentProfile,
  type StreamItem,
  type TaskStreamEnvelope,
  type TaskView,
} from "../ipc/client";

export interface ToolRow {
  time: string;
  name: string;
  status: "running" | "ok" | "error";
  /** One line of what the tool was asked to do. */
  detail?: string;
  /** One line of what it returned. */
  output?: string;
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: string;
  /** Explains an outcome that is not an error but looks like nothing happened. */
  notice?: string;
  tools: ToolRow[];
  /** Assistant turns stream; user turns are complete on creation. */
  streaming: boolean;
}

export type ChatStatus =
  | "idle"
  /** Spawning the agent. */
  | "starting"
  /** A turn is in flight. */
  | "streaming"
  /** Agent is alive and will take a follow-up — NOT a terminal state. */
  | "awaiting-input"
  | "failed";

export type Phase =
  | "idle"
  | "starting"
  | "thinking"
  | "tools"
  | "complete"
  | "failed";

/**
 * A prompt typed while the agent was busy, waiting its turn.
 *
 * It carries the mode and command that were active when you TYPED it, not
 * whatever happens to be set when it runs. Composing at drain time would give
 * every queued item the last template you picked — so `/explain this` followed
 * by `/plan that` would run as two plans.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  mode: PromptTemplate | null;
  oneShot: PromptTemplate | null;
}

interface ChatStore {
  /** One conversation == one task_id == one agent session. */
  taskId: string | null;
  workspaceId: string | null;
  /** Kept so a queued prompt can resolve `@file` mentions when it drains,
   *  long after the send that supplied it returned. */
  workspaceRoot: string | null;
  turns: Turn[];
  status: ChatStatus;
  phase: Phase;
  resolvedProfile: ResolvedAgentProfile | null;
  profileMissing: boolean;
  /** Sticky stance, applied to every message until cleared. */
  mode: PromptTemplate | null;
  /** Applies to the next message only. */
  oneShot: PromptTemplate | null;
  /** Typed while a turn was running; drains when it finishes. */
  queue: QueuedPrompt[];
  /** Held rather than drained — a turn failed or was stopped. */
  queuePaused: boolean;

  setMode(t: PromptTemplate | null): void;
  setOneShot(t: PromptTemplate | null): void;
  editQueued(id: string, text: string): void;
  setQueuedTemplates(id: string, mode: PromptTemplate | null, oneShot: PromptTemplate | null): void;
  removeQueued(id: string): void;
  resumeQueue(): void;
  refreshProfile(workspaceId: string | null): Promise<void>;
  send(workspaceId: string, text: string, workspaceRoot?: string): Promise<void>;
  stop(force: boolean): Promise<void>;
  newConversation(): Promise<void>;
  loadSession(taskId: string): Promise<void>;
  deleteSession(taskId: string): Promise<void>;
}

function now(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

let seq = 0;
const nextId = () => `t${++seq}-${Date.now()}`;

/**
 * Persist every turn by index.
 *
 * Deliberately not "persist the one turn that just finished": the agent's
 * stream can deliver `agent_end` BEFORE `agent_start_task` resolves, so at that
 * moment `taskId` is still null and a single-turn write is silently dropped —
 * which is why replayed sessions showed the user's messages but none of the
 * agent's. Writing the whole list whenever we have an id is idempotent, thanks
 * to the UNIQUE(task_id, seq) upsert, and cannot lose a turn to ordering.
 */
async function persistAll(taskId: string, turns: Turn[]) {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.text && !t.error) continue; // nothing worth storing yet
    await ipc.chatAppendTurn(taskId, i, t.role, t.text, t.error ?? null).catch(() => {});
  }
}

/**
 * Send one prompt, now. Never queues — the drain calls this, and a drain that
 * could re-queue would never empty.
 *
 * Composes with the prompt's OWN captured templates, so a queued `/explain`
 * stays an explain even if the mode changed while it waited.
 */
async function sendNow(
  set: Set,
  get: Get,
  workspaceId: string,
  item: QueuedPrompt,
  workspaceRoot?: string,
): Promise<void> {
  const { taskId, status, turns } = get();
  const { text, mode, oneShot } = item;

  // Workspace orientation is not attached here: it lives in the agent's system
  // prompt (see `workspace_context`), so it holds for every turn and after a
  // resume rather than only the first message.
  //
  // The agent receives the composed instruction; the transcript shows what the
  // user actually typed, so history stays readable. `@file` mentions resolve to
  // absolute paths for the agent while staying as written in the transcript.
  //
  // The templates come from the ITEM, so a queued prompt runs under the mode it
  // was typed under even if the mode has changed since.
  const footer = workspaceRoot ? referenceFooter(text, workspaceRoot) : "";
  const composed = footer
    ? `${composeMessage(text, mode, oneShot)}\n\n${footer}`
    : composeMessage(text, mode, oneShot);
  set({ oneShot: null });

  const userTurn: Turn = { id: nextId(), role: "user", text, tools: [], streaming: false };
  const assistantTurn: Turn = {
    id: nextId(),
    role: "assistant",
    text: "",
    tools: [],
    streaming: true,
  };
  set({ turns: [...turns, userTurn, assistantTurn], status: "streaming", phase: "thinking" });

  // A live session takes a follow-up. Starting a new task per message would
  // leave the previous agent process running — the supervisor only drops a task
  // when its own process exits.
  //
  // No `steer` branch: this is only reached when no turn is in flight, because
  // `send` queues in that case and the drain runs after `agent_end`.
  if (taskId && status === "awaiting-input") {
    try {
      await ipc.agentSend(taskId, "follow_up", composed);
      void persistAll(taskId, get().turns);
    } catch (e) {
      get().turns[get().turns.length - 1].error = formatError(e);
      set({ status: "failed", phase: "failed", turns: [...get().turns], queuePaused: true });
    }
    return;
  }

  // A conversation reopened from history has a task id but no live process: its
  // agent exited when the app closed. Reattach to that same session rather than
  // falling through to agent_start_task, which would mint a new id and silently
  // strand everything said before.
  if (taskId && status === "idle") {
    set({ status: "starting", phase: "starting", workspaceId });
    const channel = new Channel<TaskStreamEnvelope>();
    channel.onmessage = (envelope) => reduce(envelope.item, set, get);
    try {
      await invoke<TaskView>("agent_resume_task", { taskId, channel });
      // `prompt`, not `follow_up`: a just-resumed agent is idle, with the saved
      // history already loaded. Verified against a live agent — it answers from
      // the restored conversation, not from a blank one.
      await ipc.agentSend(taskId, "prompt", composed);
      set({ status: "streaming", phase: "thinking" });
      void persistAll(taskId, get().turns);
    } catch (e) {
      const t = [...get().turns];
      t[t.length - 1] = { ...t[t.length - 1], error: formatError(e), streaming: false };
      set({ turns: t, status: "failed", phase: "failed", queuePaused: true });
    }
    return;
  }

  set({ status: "starting", phase: "starting", workspaceId });
  const channel = new Channel<TaskStreamEnvelope>();
  channel.onmessage = (envelope) => reduce(envelope.item, set, get);

  try {
    const view = await invoke<TaskView>("agent_start_task", {
      workspaceId,
      prompt: composed,
      profileOverride: null,
      channel,
    });
    set({ taskId: view.id, status: "streaming" });
    // Flush whatever has already streamed in while the invoke was in flight.
    void persistAll(view.id, get().turns);
  } catch (e) {
    const t = [...get().turns];
    t[t.length - 1] = { ...t[t.length - 1], error: formatError(e), streaming: false };
    set({ turns: t, status: "failed", phase: "failed", queuePaused: true });
  }
}

/**
 * Start the next queued prompt, if the agent is free to take one.
 *
 * Called from `agent_end` rather than a timer, so the next prompt begins
 * exactly when the agent is ready and never before.
 */
function drainQueue(set: Set, get: Get): void {
  const { queue, queuePaused, workspaceId, status } = get();
  if (queuePaused || queue.length === 0 || !workspaceId) return;
  if (status === "starting" || status === "streaming") return;

  const [next, ...rest] = queue;
  set({ queue: rest });
  void sendNow(set, get, workspaceId, next, get().workspaceRoot ?? undefined);
}


export const useChat = create<ChatStore>((set, get) => ({
  taskId: null,
  workspaceId: null,
  workspaceRoot: null,
  turns: [],
  status: "idle",
  phase: "idle",
  resolvedProfile: null,
  profileMissing: false,
  mode: null,
  oneShot: null,
  queue: [],
  queuePaused: false,

  setMode: (t) => set({ mode: t }),
  setOneShot: (t) => set({ oneShot: t }),

  editQueued: (id, text) =>
    set((s) => ({ queue: s.queue.map((q) => (q.id === id ? { ...q, text } : q)) })),

  setQueuedTemplates: (id, mode, oneShot) =>
    set((s) => ({ queue: s.queue.map((q) => (q.id === id ? { ...q, mode, oneShot } : q)) })),

  removeQueued: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),

  /** Unpause and start the head immediately, if the agent is free. */
  resumeQueue: () => {
    set({ queuePaused: false });
    drainQueue(set, get);
  },

  refreshProfile: async (workspaceId) => {
    try {
      set({ resolvedProfile: await ipc.profilesResolve(workspaceId, null), profileMissing: false });
    } catch {
      set({ resolvedProfile: null, profileMissing: true });
    }
  },

  send: async (workspaceId, text, workspaceRoot) => {
    const { status, mode, oneShot } = get();

    // A turn is running: queue it rather than blocking or interrupting.
    // The templates are captured HERE, not at drain time, so each queued item
    // runs under the mode and command that were active when it was typed.
    // `oneShot` is cleared for the same reason it is on send — the next thing
    // typed starts clean.
    if (status === "starting" || status === "streaming") {
      set((s) => ({
        workspaceRoot: workspaceRoot ?? s.workspaceRoot,
        queue: [...s.queue, { id: nextId(), text, mode, oneShot }],
        oneShot: null,
        // Queuing is an intent to continue, so it lifts a pause.
        queuePaused: false,
      }));
      return;
    }
    set({ workspaceRoot: workspaceRoot ?? get().workspaceRoot });
    await sendNow(set, get, workspaceId, { id: nextId(), text, mode, oneShot }, workspaceRoot);
  },

  stop: async (force) => {
    const { taskId } = get();
    if (!taskId) return;
    await ipc.agentStopTask(taskId, force).catch(() => {});
    const t = [...get().turns];
    if (t.length) t[t.length - 1] = { ...t[t.length - 1], streaming: false };
    // Stopping is a decision to stop, so the queue holds rather than starting
    // the next thing the moment this one is cut short.
    set({ turns: t, status: "awaiting-input", phase: "complete", queuePaused: true });
    void persistAll(taskId, t);
  },

  /** Ends the current agent session before starting fresh, so processes don't
   * accumulate one per conversation. */
  newConversation: async () => {
    const { taskId } = get();
    // `true` means end the session, not abort a turn: passing false only sent
    // `abort`, which leaves the agent running — one stray process, and one
    // held session lease, for every conversation started.
    if (taskId) await ipc.agentStopTask(taskId, true).catch(() => {});
    set({
      taskId: null,
      turns: [],
      status: "idle",
      phase: "idle",
      mode: null,
      oneShot: null,
      queue: [],
      queuePaused: false,
    });
  },

  deleteSession: async (taskId) => {
    // End its agent first, or deleting the transcript leaves the process that
    // was writing it running with nothing to write to.
    await ipc.agentStopTask(taskId, true).catch(() => {});
    await ipc.chatDeleteSession(taskId).catch(() => {});
    // Deleting the conversation you're in leaves you on a fresh one.
    if (get().taskId === taskId) {
      set({ taskId: null, turns: [], status: "idle", phase: "idle", queue: [], queuePaused: false });
    }
  },

  loadSession: async (taskId) => {
    // Wind down the conversation being left. Agents are one-per-session and
    // do not stop themselves, so browsing history would otherwise leave a
    // live agent behind for every conversation opened. Reopening this one
    // resumes it from its saved session file.
    const previous = get().taskId;
    if (previous && previous !== taskId) {
      await ipc.agentStopTask(previous, true).catch(() => {});
    }

    const rows = await ipc.chatTurns(taskId).catch(() => []);
    set({
      taskId,
      turns: rows.map((r) => ({
        id: r.id,
        role: r.role as "user" | "assistant",
        text: r.text,
        error: r.errorText ?? undefined,
        tools: [],
        streaming: false,
      })),
      // Read-only until the agent for this session is running again.
      status: "idle",
      phase: "complete",
      // A queue belongs to the conversation it was typed into.
      queue: [],
      queuePaused: false,
    });
  },
}));

/**
 * Name a conversation after its first exchange, exactly once.
 *
 * Fired here rather than on send because a title wants the agent's reply too —
 * "fix the resume bug" is a better label than "why doesn't this work". Best
 * effort throughout: with no key the list still falls back to the user's own
 * first message.
 */
const named = new Set<string>();
async function nameOnce(taskId: string, get: Get) {
  if (named.has(taskId)) return;
  const turns = get().turns;
  // One full exchange: the user asked and the agent answered.
  if (turns.length < 2 || !turns.some((t) => t.role === "assistant" && t.text)) return;
  named.add(taskId);
  await ipc.chatTitle(taskId).catch(() => named.delete(taskId));
  // Nudge the sessions list to re-read.
  set_titleTick((n) => n + 1);
}

/** Bumped when a title lands, so the sessions panel refreshes. */
let titleListeners: Array<(n: number) => void> = [];
let titleTick = 0;
function set_titleTick(fn: (n: number) => number) {
  titleTick = fn(titleTick);
  titleListeners.forEach((l) => l(titleTick));
}
export function onTitleChange(fn: (n: number) => void): () => void {
  titleListeners.push(fn);
  return () => {
    titleListeners = titleListeners.filter((l) => l !== fn);
  };
}

type Set = (partial: Partial<ChatStore>) => void;
type Get = () => ChatStore;

/** Mutate the open assistant turn (always the last one). */
function patchLast(get: Get, set: Set, fn: (t: Turn) => Turn) {
  const turns = [...get().turns];
  const i = turns.length - 1;
  if (i < 0 || turns[i].role !== "assistant") return;
  turns[i] = fn(turns[i]);
  set({ turns });
}

/**
 * Exported for tests. The `agent_end` → drain wiring is the part most likely
 * to break, and reaching it through a real Tauri channel in a test would prove
 * less than driving the reducer directly.
 */
export function reduce(item: StreamItem, set: Set, get: Get) {
  if (item.kind === "process_exited") {
    if (get().status !== "idle") {
      patchLast(get, set, (t) => ({ ...t, streaming: false }));
      set({ status: "failed", phase: "failed", taskId: null, queuePaused: true });
    }
    return;
  }
  if (item.kind !== "event") return;
  const o = item as unknown as Record<string, unknown>;

  switch (item.type) {
    case "agent_start":
      set({ status: "streaming", phase: "thinking" });
      break;

    case "message_update": {
      const delta = extractDelta(o.assistantMessageEvent);
      if (delta) patchLast(get, set, (t) => ({ ...t, text: t.text + delta }));
      break;
    }

    case "message_end": {
      const m = describeMessage(o.message);
      if (m.role !== "assistant") break;
      if (m.errorMessage) {
        patchLast(get, set, (t) => ({ ...t, error: m.errorMessage, streaming: false }));
        // Hold the queue: draining into a failed agent turns one failure into
        // a run of them, and the prompts are still there to resume or edit.
        set({ status: "failed", phase: "failed", queuePaused: true });
        const { taskId } = get();
        if (taskId) void persistAll(taskId, get().turns);
      } else if (m.text) {
        patchLast(get, set, (t) =>
          t.text.includes(m.text) ? t : { ...t, text: t.text ? `${t.text}\n\n${m.text}` : m.text },
        );
      }
      break;
    }

    case "tool_execution_start":
      set({ phase: "tools" });
      patchLast(get, set, (t) => ({
        ...t,
        tools: [
          ...t.tools,
          {
            time: now(),
            name: String(o.toolName ?? "tool"),
            status: "running",
            detail: summarizeToolArgs(o.args),
          },
        ],
      }));
      break;

    case "tool_execution_end":
      set({ phase: "thinking" });
      patchLast(get, set, (t) => {
        const tools = [...t.tools];
        const i = tools.findLastIndex(
          (r) => r.name === String(o.toolName ?? "tool") && r.status === "running",
        );
        if (i >= 0) {
          tools[i] = {
            ...tools[i],
            status: o.isError ? "error" : "ok",
            output: toolResultText(o.result),
          };
        }
        return { ...t, tools };
      });
      break;

    case "auto_retry_start":
      patchLast(get, set, (t) => ({
        ...t,
        tools: [
          ...t.tools,
          {
            time: now(),
            name: `retry ${o.attempt}/${o.maxAttempts} — ${String(o.errorMessage ?? "").slice(0, 70)}`,
            status: "error",
          },
        ],
      }));
      break;

    case "agent_end": {
      // NOT terminal: the process stays alive and accepts follow-ups. Treating
      // this as "succeeded" is what made the conversation single-shot.
      //
      // A turn that ran tools and then produced no words is the shape a context
      // overflow takes: the model reads a file, exceeds its window, and the
      // reply never comes. Showing a bare "Done" made that look like the app
      // losing the answer, so name it and say what to do about it.
      patchLast(get, set, (t) =>
        !t.text && !t.error && t.tools.length > 0
          ? {
              ...t,
              streaming: false,
              notice:
                "The agent ran tools but returned no reply. That usually means the model ran out " +
                "of context — pick one with a larger context window in Settings → Providers.",
            }
          : { ...t, streaming: false },
      );
      if (get().status !== "failed") set({ status: "awaiting-input", phase: "complete" });
      const { taskId, turns } = get();
      if (taskId) {
        void persistAll(taskId, turns).then(() => nameOnce(taskId, get));
      }
      // The agent is free now, so hand it whatever was typed while it worked.
      // Driven from here rather than a timer: this is the moment the agent
      // becomes ready, and anything earlier would talk over the running turn.
      drainQueue(set, get);
      break;
    }

    default:
      break;
  }
}
