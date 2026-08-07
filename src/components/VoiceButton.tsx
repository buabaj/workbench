import { Mic, Square, X } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import type { VoicePhase } from "../store/voice";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Recording shows the orb in its `listening` state with the elapsed time in
 * tabular figures, so the row doesn't jitter as digits change.
 */
export function VoiceButton({
  phase,
  elapsedMs,
  configured,
  onToggle,
  onCancel,
}: {
  phase: VoicePhase;
  elapsedMs: number;
  configured: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  if (phase === "recording") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-2)",
          padding: "5px 8px 5px 10px",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--r-pill)",
          background: "var(--surface)",
        }}
      >
        <AgentOrb phase="listening" />
        <span
          style={{
            fontSize: "var(--text-xs)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--ink-secondary)",
            minWidth: 30,
          }}
        >
          {formatElapsed(elapsedMs)}
        </span>
        <button
          className="btn icon"
          onClick={onToggle}
          aria-label={`Stop recording and transcribe, ${formatElapsed(elapsedMs)} elapsed`}
          title="Stop and transcribe (⌘⇧V)"
          style={{ padding: 4 }}
        >
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </button>
        <button
          className="btn icon"
          onClick={onCancel}
          aria-label="Discard recording"
          title="Discard"
          style={{ padding: 4 }}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div className="btn icon" aria-live="polite" aria-label="Transcribing" title="Transcribing…">
        <AgentOrb phase="transcribing" />
      </div>
    );
  }

  return (
    <button
      className="btn icon"
      disabled={!configured}
      onClick={onToggle}
      aria-label={configured ? "Record and transcribe" : "Voice transcription not configured"}
      title={configured ? "Record and transcribe (⌘⇧V)" : "Add an OpenRouter key in Settings"}
    >
      <Mic size={16} strokeWidth={1.6} />
    </button>
  );
}
