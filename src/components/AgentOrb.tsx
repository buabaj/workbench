import { ThinkingOrb } from "thinking-orbs";

/**
 * The agent's live state, as an orb.
 *
 * `thinking-orbs` (MIT, zero-dep, canvas arcs only — no WebGL, no external
 * assets, no eval) renders a static representative frame under
 * `prefers-reduced-motion`, which is why it can carry state at all: the shape
 * still differs when the motion is gone. It is paired with a text label
 * everywhere it appears, so state is never motion-only.
 */
export type AgentPhase =
  | "idle"
  | "starting"
  | "thinking"
  | "tools"
  | "listening"
  | "transcribing"
  | "complete"
  | "failed";

/** Each phase gets a visually distinct orb, not just a different speed. */
const ORB_STATE = {
  idle: "breathing",
  starting: "connecting",
  thinking: "working",
  tools: "solving",
  listening: "listening",
  transcribing: "composing",
  complete: "breathing",
  failed: "breathing",
} as const;

export const PHASE_LABEL: Record<AgentPhase, string> = {
  idle: "Ready",
  starting: "Starting",
  thinking: "Thinking",
  tools: "Running tools",
  listening: "Listening",
  transcribing: "Transcribing",
  complete: "Done",
  failed: "Failed",
};

/** Terminal phases hold still. Idle keeps a slow breath: a completely frozen
 * indicator reads as broken rather than restful. */
const STATIC: AgentPhase[] = ["complete", "failed"];

export function AgentOrb({
  phase,
  size = 20,
}: {
  phase: AgentPhase;
  size?: 20 | 64;
}) {
  return (
    <span
      style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0 }}
      // The orb is decoration here; the adjacent label carries the state.
      aria-hidden
    >
      <ThinkingOrb
        state={ORB_STATE[phase]}
        size={size}
        paused={STATIC.includes(phase)}
        speed={phase === "idle" ? 0.5 : phase === "tools" ? 1.25 : 1}
      />
    </span>
  );
}

/** Maps the task store's status + matrix onto a single phase. */
export function phaseFromTask(
  status: string,
  matrix: string,
): AgentPhase {
  if (status === "starting") return "starting";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "idle";
  if (status === "succeeded") return "complete";
  if (status === "running") return matrix === "running-tools" ? "tools" : "thinking";
  return "idle";
}
