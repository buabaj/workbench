import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { describeMessage, extractDelta } from "../chat/normalize";
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
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  error?: string;
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

interface ChatStore {
  /** One conversation == one task_id == one agent session. */
  taskId: string | null;
  workspaceId: string | null;
  turns: Turn[];
  status: ChatStatus;
  phase: Phase;
  resolvedProfile: ResolvedAgentProfile | null;
  profileMissing: boolean;
  /** Sticky stance, applied to every message until cleared. */
  mode: PromptTemplate | null;
  /** Applies to the next message only. */
  oneShot: PromptTemplate | null;

  setMode(t: PromptTemplate | null): void;
  setOneShot(t: PromptTemplate | null): void;
  refreshProfile(workspaceId: string | null): Promise<void>;
  send(workspaceId: string, text: string): Promise<void>;
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

export const useChat = create<ChatStore>((set, get) => ({
  taskId: null,
  workspaceId: null,
  turns: [],
  status: "idle",
  phase: "idle",
  resolvedProfile: null,
  profileMissing: false,
  mode: null,
  oneShot: null,

  setMode: (t) => set({ mode: t }),
  setOneShot: (t) => set({ oneShot: t }),

  refreshProfile: async (workspaceId) => {
    try {
      set({ resolvedProfile: await ipc.profilesResolve(workspaceId, null), profileMissing: false });
    } catch {
      set({ resolvedProfile: null, profileMissing: true });
    }
  },

  send: async (workspaceId, text) => {
    const { taskId, status, turns, mode, oneShot } = get();

    // The agent receives the composed instruction; the transcript shows what
    // the user actually typed, so history stays readable.
    const composed = composeMessage(text, mode, oneShot);
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
    // leave the previous agent process running — the supervisor only drops a
    // task when its own process exits.
    if (taskId && (status === "awaiting-input" || status === "streaming")) {
      const command = status === "streaming" ? "steer" : "follow_up";
      try {
        await ipc.agentSend(taskId, command, composed);
        void persistAll(taskId, get().turns);
      } catch (e) {
        get().turns[get().turns.length - 1].error = formatError(e);
        set({ status: "failed", phase: "failed", turns: [...get().turns] });
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
      set({ turns: t, status: "failed", phase: "failed" });
    }
  },

  stop: async (force) => {
    const { taskId } = get();
    if (!taskId) return;
    await ipc.agentStopTask(taskId, force).catch(() => {});
    const t = [...get().turns];
    if (t.length) t[t.length - 1] = { ...t[t.length - 1], streaming: false };
    set({ turns: t, status: "awaiting-input", phase: "complete" });
    void persistAll(taskId, t);
  },

  /** Ends the current agent session before starting fresh, so processes don't
   * accumulate one per conversation. */
  newConversation: async () => {
    const { taskId } = get();
    if (taskId) await ipc.agentStopTask(taskId, false).catch(() => {});
    set({ taskId: null, turns: [], status: "idle", phase: "idle", mode: null, oneShot: null });
  },

  deleteSession: async (taskId) => {
    await ipc.chatDeleteSession(taskId).catch(() => {});
    // Deleting the conversation you're in leaves you on a fresh one.
    if (get().taskId === taskId) {
      set({ taskId: null, turns: [], status: "idle", phase: "idle" });
    }
  },

  loadSession: async (taskId) => {
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
    });
  },
}));

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

function reduce(item: StreamItem, set: Set, get: Get) {
  if (item.kind === "process_exited") {
    if (get().status !== "idle") {
      patchLast(get, set, (t) => ({ ...t, streaming: false }));
      set({ status: "failed", phase: "failed", taskId: null });
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
        set({ status: "failed", phase: "failed" });
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
        tools: [...t.tools, { time: now(), name: String(o.toolName ?? "tool"), status: "running" }],
      }));
      break;

    case "tool_execution_end":
      set({ phase: "thinking" });
      patchLast(get, set, (t) => {
        const tools = [...t.tools];
        const i = tools.findLastIndex(
          (r) => r.name === String(o.toolName ?? "tool") && r.status === "running",
        );
        if (i >= 0) tools[i] = { ...tools[i], status: o.isError ? "error" : "ok" };
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
      patchLast(get, set, (t) => ({ ...t, streaming: false }));
      if (get().status !== "failed") set({ status: "awaiting-input", phase: "complete" });
      const { taskId, turns } = get();
      if (taskId) void persistAll(taskId, turns);
      break;
    }

    default:
      break;
  }
}
