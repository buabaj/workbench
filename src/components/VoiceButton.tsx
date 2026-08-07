import { Mic, Square, X } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { DotWaveform } from "./ButterflyMark";
import type { VoicePhase } from "../store/voice";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Recording shows a live dot-column level meter — it proves the microphone is
 * hearing you, which a generic animation cannot. The orb is reserved for
 * thinking, so the two states never look alike.
 */
export function VoiceButton({
  phase,
  elapsedMs,
  levels,
  configured,
  onToggle,
  onCancel,
}: {
  phase: VoicePhase;
  elapsedMs: number;
  levels: number[];
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
          border: "1px solid var(--clay)",
          borderRadius: "var(--r-pill)",
          background: "var(--clay-wash)",
        }}
      >
        <DotWaveform levels={levels} />
        <span
          style={{
            fontSize: "var(--text-xs)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--clay-text)",
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
