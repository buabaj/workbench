import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { MatrixState } from "../components/DotMatrix";
import {
  ipc,
  type ResolvedAgentProfile,
  type StreamItem,
  type TaskStreamEnvelope,
  type TaskView,
} from "../ipc/client";

export interface ToolFeedRow {
  time: string;
  name: string;
  status: "running" | "ok" | "error";
}

/**
 * TIGHTEN-LATER(assistant-message-event): the internal discriminants of
 * assistantMessageEvent are unverified upstream. This is the ONLY place that
 * interprets it — tightening later is a one-function change.
 */
function extractDelta(ev: unknown): string {
  if (typeof ev !== "object" || ev === null) return "";
  const o = ev as Record<string, unknown>;
  if (typeof o.delta === "string") return o.delta;
  if (typeof o.text === "string") return o.text;
  return "";
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
          const delta = extractDelta(
            (item as Record<string, unknown>).assistantMessageEvent,
          );
          if (delta) set({ text: get().text + delta, matrix: "thinking" });
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
          set({ status: "succeeded", matrix: "complete" });
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
