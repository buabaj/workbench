import { DotWaveform } from "./DotMatrix";
import type { VoicePhase } from "../store/voice";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Recording reads as the app's own dot language — a live level histogram —
 * rather than a red blob. The elapsed time sits beside it in tabular figures
 * so the row doesn't jitter as digits change.
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
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="1.5" y="1.5" width="9" height="9" rx="2.5" fill="currentColor" />
          </svg>
        </button>
        <button
          className="btn icon"
          onClick={onCancel}
          aria-label="Discard recording"
          title="Discard"
          style={{ padding: 4 }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div
        className="btn icon"
        aria-live="polite"
        aria-label="Transcribing"
        title="Transcribing…"
        style={{ opacity: 0.8 }}
      >
        <span className="matrix animate" style={{ gridTemplateColumns: "repeat(3, 3px)" }}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <i key={i} className={i % 3 === 1 ? "a" : ""} />
          ))}
        </span>
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
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <rect x="6" y="2" width="4" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
