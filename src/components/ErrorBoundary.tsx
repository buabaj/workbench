import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a render crash in one panel from blanking the whole window. Editor
 * state lives in the module-level registry, so recovering re-mounts cleanly
 * with unsaved buffers intact.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          padding: 16,
          fontSize: 11,
          color: "var(--ink-muted)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <div style={{ color: "var(--danger)" }}>Something in the interface failed to render.</div>
        <div style={{ fontSize: 10, userSelect: "text" }}>{this.state.error.message}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
