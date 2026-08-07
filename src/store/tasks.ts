import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { describeMessage, extractDelta } from "../chat/normalize";
import {
  ipc,
  type ResolvedAgentProfile,
  type StreamItem,
  type TaskStreamEnvelope,
  type TaskView,
} from "../ipc/client";

/** Internal detail phase; the UI maps this onto an orb via phaseFromTask. */
export type MatrixState =
  | "awaiting-input"
  | "thinking"
  | "running-tools"
  | "complete"
  | "failed";

export interface ToolFeedRow {
  time: string;
  name: string;
  status: "running" | "ok" | "error";
}

interface TasksStore {
  taskId: string | null;
  status: "idle" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  matrix: MatrixState;
  toolFeed: ToolFeedRow[];
  text: string;
  error: string | null;
  resolvedProfile: ResolvedAgentProfile | null;
  profileMissing: boolean;

  refreshProfile(workspaceId: string | null): Promise<void>;
  runTask(workspaceId: string, prompt: string): Promise<void>;
  stopTask(force: boolean): Promise<void>;
  reset(): void;
}

function now(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

export const useTasks = create<TasksStore>((set, get) => ({
  taskId: null,
  status: "idle",
  matrix: "awaiting-input",
  toolFeed: [],
  text: "",
  error: null,
  resolvedProfile: null,
  profileMissing: false,

  refreshProfile: async (workspaceId) => {
    try {
      const resolved = await ipc.profilesResolve(workspaceId, null);
      set({ resolvedProfile: resolved, profileMissing: false });
    } catch {
      set({ resolvedProfile: null, profileMissing: true });
    }
  },

  runTask: async (workspaceId, prompt) => {
    set({
      status: "starting",
      matrix: "thinking",
      toolFeed: [],
      text: "",
      error: null,
    });

    const channel = new Channel<TaskStreamEnvelope>();
    channel.onmessage = (envelope) => {
      handleItem(envelope.item, set, get);
    };

    try {
      const view = await invoke<TaskView>("agent_start_task", {
        workspaceId,
        prompt,
        profileOverride: null,
        channel,
      });
      set({ taskId: view.id, status: "running" });
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "detail" in e
          ? String((e as { detail: unknown }).detail)
          : String(e);
      set({ status: "failed", matrix: "failed", error: message });
    }
  },

  stopTask: async (force) => {
    const { taskId } = get();
    if (!taskId) return;
    await ipc.agentStopTask(taskId, force).catch(() => {});
    set({ status: "cancelled", matrix: "awaiting-input" });
  },

  reset: () =>
    set({
      taskId: null,
      status: "idle",
      matrix: "awaiting-input",
      toolFeed: [],
      text: "",
      error: null,
    }),
}));

type Set = (partial: Partial<ReturnType<typeof useTasks.getState>>) => void;

function handleItem(item: StreamItem, set: Set, get: () => ReturnType<typeof useTasks.getState>) {
  switch (item.kind) {
    case "event": {
      switch (item.type) {
        case "agent_start":
          set({ status: "running", matrix: "thinking" });
          break;
        case "message_update": {
          const delta = extractDelta((item as Record<string, unknown>).assistantMessageEvent);
          if (delta) set({ text: get().text + delta, matrix: "thinking" });
          break;
        }
        case "message_end": {
          // The main text path: a live capture shows no message_update events,
          // with the reply carried as content parts on message_end.
          const m = describeMessage((item as Record<string, unknown>).message);
          if (m.role === "assistant") {
            if (m.errorMessage) {
              // A failed request still emits agent_end, so without this a hard
              // failure rendered as "complete" with an empty reply.
              set({ status: "failed", matrix: "failed", error: m.errorMessage });
            } else if (m.text && !get().text.includes(m.text)) {
              set({ text: get().text ? `${get().text}\n\n${m.text}` : m.text });
            }
          }
          break;
        }
        case "auto_retry_start": {
          const o = item as Record<string, unknown>;
          set({
            toolFeed: [
              ...get().toolFeed.slice(-11),
              {
                time: now(),
                name: `retry ${o.attempt}/${o.maxAttempts} — ${String(o.errorMessage ?? "").slice(0, 80)}`,
                status: "error",
              },
            ],
          });
          break;
        }
        case "tool_execution_start": {
          const name = String((item as Record<string, unknown>).toolName ?? "tool");
          set({
            matrix: "running-tools",
            toolFeed: [...get().toolFeed.slice(-11), { time: now(), name, status: "running" }],
          });
          break;
        }
        case "tool_execution_end": {
          const name = String((item as Record<string, unknown>).toolName ?? "tool");
          const isError = Boolean((item as Record<string, unknown>).isError);
          const feed = [...get().toolFeed];
          const idx = feed.findLastIndex((r) => r.name === name && r.status === "running");
          if (idx >= 0) feed[idx] = { ...feed[idx], status: isError ? "error" : "ok" };
          set({ matrix: "thinking", toolFeed: feed });
          break;
        }
        case "agent_end":
          // Only a success if nothing already failed this run.
          if (get().status !== "failed") set({ status: "succeeded", matrix: "complete" });
          break;
        default:
          break;
      }
      break;
    }
    case "process_exited": {
      const s = get().status;
      if (s !== "succeeded" && s !== "cancelled") {
        set({ status: "failed", matrix: "failed", error: `agent exited (code ${item.code})` });
      }
      break;
    }
    case "protocol_error":
      // Diagnostic only; never fatal to the stream.
      console.warn("protocol error from agent:", item.reason);
      break;
    default:
      break;
  }
}
