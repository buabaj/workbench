import { useEffect, useState } from "react";
import { formatError, ipc, type CapabilityStatus, type ModelInfo } from "../ipc/client";

/**
 * What Workbench's own AI does, and on what.
 *
 * These run without being asked — naming a conversation, tidying dictation,
 * answering an `@agent[…]` — so the one thing this page owes you is a straight
 * answer about what is running and where the text goes. The model is editable
 * because the defaults are a judgement about cost and context window, and it
 * is your key and your text.
 *
 * The candidate list comes from OpenRouter filtered by the capability's own
 * modality requirements, so a text model can never be chosen for transcription.
 */
function ModelPicker({
  capability,
  onDone,
}: {
  capability: CapabilityStatus;
  onDone: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let live = true;
    ipc
      .modelsForCapability(capability.key)
      .then((m) => live && setModels(m))
      .catch((e) => live && setErr(formatError(e)));
    return () => {
      live = false;
    };
  }, [capability.key]);

  const choose = async (id: string) => {
    try {
      await ipc.capabilityChooseModels(capability.key, [id]);
      onDone();
    } catch (e) {
      setErr(formatError(e));
    }
  };

  if (err) {
    return (
      <div role="alert" style={{ fontSize: "var(--text-xs)", color: "var(--error)" }}>
        {err}
      </div>
    );
  }
  if (!models) {
    return (
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}>
        Loading the catalogue…
      </div>
    );
  }

  const shown = models
    .filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 60);

  return (
    <div style={{ marginTop: "var(--s-2)" }}>
      <input
        className="field"
        autoFocus
        placeholder={`Filter ${models.length} models`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: "100%", fontSize: "var(--text-xs)", padding: "3px 8px" }}
      />
      <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 4 }}>
        {shown.map((m) => (
          <button
            key={m.id}
            className="rail-item"
            onClick={() => void choose(m.id)}
            style={{
              display: "flex",
              width: "100%",
              textAlign: "left",
              background: "none",
              border: 0,
              fontFamily: "var(--mono)",
              fontSize: "var(--text-xs)",
              color: "var(--ink-secondary)",
            }}
          >
            {m.id}
          </button>
        ))}
        {shown.length === 0 && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", padding: 4 }}>
            No model matching that also meets what this capability needs.
          </div>
        )}
      </div>
      <button
        className="btn small"
        onClick={onDone}
        style={{ marginTop: 4 }}
      >
        Cancel
      </button>
    </div>
  );
}

export function CapabilityList() {
  const [items, setItems] = useState<CapabilityStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => {
    ipc
      .capabilityStatus()
      .then(setItems)
      .catch((e) => setErr(formatError(e)));
  };
  useEffect(refresh, []);

  const reset = async (key: string) => {
    try {
      // An empty list is the reset: there is no second kind of "no choice".
      await ipc.capabilityChooseModels(key, []);
      refresh();
    } catch (e) {
      setErr(formatError(e));
    }
  };

  if (err) {
    return (
      <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--error)" }}>
        {err}
      </div>
    );
  }
  if (!items) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      {items.map((c) => (
        <div key={c.key} className="card">
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-2)" }}>
            <span style={{ fontSize: "var(--text-sm)", color: "var(--ink)" }}>
              {c.displayName}
            </span>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                flex: 1,
              }}
            >
              {c.key}
            </span>
            {c.chosen && (
              <button className="btn small" onClick={() => void reset(c.key)}>
                Reset
              </button>
            )}
            <button
              className="btn small"
              onClick={() => setEditing(editing === c.key ? null : c.key)}
            >
              {editing === c.key ? "Close" : "Change model"}
            </button>
          </div>

          {/* The whole chain, because the first is only what is tried first —
              a fallback answering is normal, not an error. */}
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: "var(--text-xs)",
              color: "var(--ink-muted)",
              marginTop: 4,
            }}
          >
            {c.effectiveModels.join(" → ")}
          </div>
          {c.chosen && (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", marginTop: 2 }}>
              chosen here · default is {c.defaultModels[0]}
            </div>
          )}

          {editing === c.key && <ModelPicker capability={c} onDone={() => {
            setEditing(null);
            refresh();
          }} />}
        </div>
      ))}
    </div>
  );
}
