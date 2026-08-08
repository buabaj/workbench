import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { formatError, ipc, type TranscriptResult, type VoiceCapability } from "../ipc/client";

export type VoicePhase =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "transcribing"
  | "error";

/** ~1s of 48 kHz mono i16 before shipping a chunk to Rust. */
const CHUNK_SAMPLES = 48_000;

interface VoiceStore {
  phase: VoicePhase;
  elapsedMs: number;
  level: number;
  /** Rolling input levels feeding the dot waveform. */
  levels: number[];
  error: string | null;
  capability: VoiceCapability | null;

  refreshCapability(): Promise<void>;
  toggle(onTranscript: (text: string) => void): Promise<void>;
  cancel(): Promise<void>;
}

interface Live {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  sessionId: string;
  buffer: Int16Array[];
  buffered: number;
  timer: number;
}

let live: Live | null = null;

async function flush(force: boolean): Promise<void> {
  if (!live) return;
  if (!force && live.buffered < CHUNK_SAMPLES) return;
  if (live.buffered === 0) return;

  const merged = new Int16Array(live.buffered);
  let offset = 0;
  for (const part of live.buffer) {
    merged.set(part, offset);
    offset += part.length;
  }
  live.buffer = [];
  live.buffered = 0;

  const ack = await invoke<{ limitState: "ok" | "warn" | "hard"; elapsedMs: number }>(
    "voice_push",
    new Uint8Array(merged.buffer),
    { headers: { "x-session-id": live.sessionId } },
  );
  useVoice.setState({ elapsedMs: ack.elapsedMs });
  if (ack.limitState === "hard") {
    // Server-side limit reached; stop immediately rather than trusting the UI.
    await useVoice.getState().cancel();
    useVoice.setState({
      phase: "error",
      error: "Recording limit reached (2 minutes).",
    });
  }
}

function teardown() {
  if (!live) return;
  live.node.port.onmessage = null;
  live.node.disconnect();
  live.stream.getTracks().forEach((t) => t.stop());
  void live.ctx.close();
  window.clearInterval(live.timer);
  live = null;
}

export const useVoice = create<VoiceStore>((set, get) => ({
  phase: "idle",
  elapsedMs: 0,
  level: 0,
  levels: [],
  error: null,
  capability: null,

  refreshCapability: async () => {
    const capability = await ipc.voiceCapability().catch(() => null);
    set({ capability });
  },

  toggle: async (onTranscript) => {
    const phase = get().phase;

    // ── stop & transcribe ──────────────────────────────────────────────
    if (phase === "recording") {
      const sessionId = live?.sessionId;
      await flush(true).catch(() => {});
      teardown();
      if (!sessionId) {
        set({ phase: "idle" });
        return;
      }
      set({ phase: "transcribing" });
      try {
        const result: TranscriptResult = await ipc.voiceFinish(sessionId, null);
        // Tidy the fillers and punctuation before it lands. Its failure is not
        // yours: anything other than a plausible clean-up of what you said —
        // an error, a timeout, no key, a model that answered instead — falls
        // back to the raw transcript, which is why this can run unasked.
        const text = await ipc
          .transcriptCleanup(result.text)
          .then((c) => c.text)
          .catch(() => result.text);
        // Insert as editable text. There is deliberately no path from here to
        // submitting the task — the user edits and sends it themselves.
        onTranscript(text);
        set({ phase: "idle", elapsedMs: 0, error: null, levels: [] });
      } catch (e) {
        set({ phase: "error", error: formatError(e) });
      }
      return;
    }

    if (phase === "transcribing" || phase === "requesting-permission") return;

    // ── start ──────────────────────────────────────────────────────────
    set({ phase: "requesting-permission", error: null, elapsedMs: 0 });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-capture");

      const sessionId = await ipc.voiceBegin(Math.round(ctx.sampleRate));

      live = {
        ctx,
        stream,
        node,
        sessionId,
        buffer: [],
        buffered: 0,
        timer: window.setInterval(() => void flush(false), 250),
      };

      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!live) return;
        const samples = new Int16Array(event.data);
        live.buffer.push(samples);
        live.buffered += samples.length;
        // Cheap level meter for the recording indicator.
        let peak = 0;
        for (let i = 0; i < samples.length; i += 16) {
          peak = Math.max(peak, Math.abs(samples[i]));
        }
        const level = peak / 32768;
        const prev = useVoice.getState().levels;
        useVoice.setState({ level, levels: [...prev.slice(-40), level] });
      };

      source.connect(node);
      set({ phase: "recording" });
    } catch (e) {
      teardown();
      const name = (e as { name?: string })?.name;
      set({
        phase: "error",
        error:
          name === "NotAllowedError"
            ? "Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone."
            : formatError(e),
      });
    }
  },

  cancel: async () => {
    const sessionId = live?.sessionId;
    teardown();
    if (sessionId) await ipc.voiceCancel(sessionId).catch(() => {});
    set({ phase: "idle", elapsedMs: 0, level: 0, levels: [] });
  },
}));
