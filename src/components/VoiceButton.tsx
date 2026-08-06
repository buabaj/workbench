import type { VoicePhase } from "../store/voice";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A 20px icon, not a button with a word in it. Recording turns it into a stop
 * glyph with the elapsed time inline; the level ring gives feedback without
 * needing a meter.
 */
export function VoiceButton({
  phase,
  elapsedMs,
  level,
  configured,
  onToggle,
  onCancel,
}: {
  phase: VoicePhase;
  elapsedMs: number;
  level: number;
  configured: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  if (phase === "recording") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          className="btn recording"
          onClick={onToggle}
          aria-label={`Stop recording and transcribe, ${formatElapsed(elapsedMs)} elapsed`}
          title="Stop and transcribe (⌘⇧V)"
          style={{ padding: "6px 10px", fontVariantNumeric: "tabular-nums" }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect width="10" height="10" rx="2" fill="currentColor" />
          </svg>
          {formatElapsed(elapsedMs)}
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "currentColor",
              opacity: 0.3 + Math.min(level * 3, 0.7),
              transition: "opacity 80ms linear",
            }}
          />
        </button>
        <button className="btn icon" onClick={onCancel} aria-label="Discard recording" title="Discard">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  const busy = phase === "transcribing";
  return (
    <button
      className="btn icon"
      disabled={busy || !configured}
      onClick={onToggle}
      aria-label={configured ? "Record and transcribe" : "Voice transcription not configured"}
      title={
        configured
          ? "Record and transcribe (⌘⇧V)"
          : "Configure voice transcription in settings"
      }
      style={busy ? { opacity: 0.6 } : undefined}
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
