import { useEffect, useRef, useState } from "react";
import { ipc, type CredentialProfileView, type HostAuthSummary } from "../ipc/client";
import { useTasks } from "../store/tasks";
import { useWorkspace } from "../store/workspace";

const SLUGS = [
  "anthropic",
  "openai",
  "openrouter",
  "prime-inference",
  "kimi-coding",
  "google",
] as const;

/** Create credential + agent profile + set as app default, in one step. */
async function setupProfile(opts: {
  label: string;
  authKind: "api_key" | "oauth_host";
  providerSlug: string;
  apiKey?: string;
  modelId?: string;
}) {
  const cred = await ipc.credsAdd({
    label: opts.label,
    authKind: opts.authKind,
    providerSlug: opts.providerSlug,
    scope: "agent",
    apiKey: opts.apiKey,
  });
  const profile = await ipc.agentProfilesUpsert({
    label: opts.label,
    credentialProfileId: cred.id,
    modelId: opts.modelId,
    thinkingLevel: "medium",
  });
  await ipc.profilesSetDefault(null, profile.id);
}

/** Voice needs its own credential assignment: an OpenRouter key must be
 * granted to the app-AI service explicitly, never inherited from the agent. */
function VoiceSetup() {
  const [creds, setCreds] = useState<CredentialProfileView[]>([]);
  const [configured, setConfigured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void ipc.credsList().then(setCreds).catch(() => {});
    void ipc
      .voiceCapability()
      .then((c) => setConfigured(c.configured ? (c.credentialLabel ?? "configured") : null))
      .catch(() => {});
  }, []);

  const openRouterCreds = creds.filter((c) => c.providerSlug === "openrouter");

  const enable = async (credentialId: string) => {
    setBusy(true);
    try {
      // Strict privacy by default: zdr + data_collection deny + no provider
      // fallbacks. Model chain comes from the capability registry.
      await ipc.voiceConfigure(credentialId, [], "strict");
      const c = await ipc.voiceCapability();
      setConfigured(c.credentialLabel ?? "configured");
    } finally {
      setBusy(false);
    }
  };

  const addKeyAndEnable = async () => {
    const el = keyRef.current;
    if (!el?.value) return;
    const key = el.value;
    el.value = "";
    setBusy(true);
    try {
      const cred = await ipc.credsAdd({
        label: "OpenRouter (voice)",
        authKind: "api_key",
        providerSlug: "openrouter",
        scope: "appai",
        apiKey: key,
      });
      await enable(cred.id);
    } finally {
      setBusy(false);
    }
  };

  const field: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--structure-strong)",
    borderRadius: "var(--r)",
    color: "var(--ink)",
    font: "inherit",
    padding: "7px 10px",
    width: "100%",
  };

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid var(--structure)", paddingTop: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--ink-faint)", marginBottom: 8 }}>
        VOICE TRANSCRIPTION (OPENROUTER)
      </div>
      {configured ? (
        <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>
          Enabled via <span style={{ color: "var(--ink)" }}>{configured}</span> · strict privacy
          (zero-retention, no provider fallbacks)
        </div>
      ) : openRouterCreds.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {openRouterCreds.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
              <span style={{ flex: 1 }}>{c.label}</span>
              <button className="btn" disabled={busy} onClick={() => void enable(c.id)}>
                Use for voice
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>
            Add an OpenRouter key to enable dictation. It is stored in the Keychain and used only
            for Workbench's own AI features.
          </div>
          <input
            ref={keyRef}
            style={field}
            type="password"
            placeholder="OpenRouter API key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
          />
          <button
            className="btn"
            disabled={busy}
            style={{ alignSelf: "flex-start" }}
            onClick={() => void addKeyAndEnable()}
          >
            Enable voice
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [host, setHost] = useState<HostAuthSummary[]>([]);
  const [slug, setSlug] = useState<string>("anthropic");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Secret hygiene: uncontrolled input, read once at submit, cleared instantly.
  const keyRef = useRef<HTMLInputElement>(null);

  const workspace = useWorkspace((s) => s.workspace);
  const refreshProfile = useTasks((s) => s.refreshProfile);

  useEffect(() => {
    void ipc.credsDiscoverHostAuth().then(setHost).catch(() => {});
  }, []);

  const finish = async () => {
    await refreshProfile(workspace?.id ?? null);
    onClose();
  };

  const useHost = async (h: HostAuthSummary) => {
    setBusy(true);
    setErr(null);
    try {
      await setupProfile({
        label: `${h.providerSlug} (host session)`,
        authKind: "oauth_host",
        providerSlug: h.providerSlug,
      });
      await finish();
    } catch (e) {
      setErr(String((e as { detail?: unknown })?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  const addKey = async () => {
    const el = keyRef.current;
    if (!el) return;
    const key = el.value;
    el.value = "";
    if (!key) {
      setErr("enter an API key");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await setupProfile({
        label: label.trim() || `${slug} key`,
        authKind: "api_key",
        providerSlug: slug,
        apiKey: key,
        modelId: model.trim() || undefined,
      });
      await finish();
    } catch (e) {
      setErr(String((e as { detail?: unknown })?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--structure-strong)",
    borderRadius: "var(--r)",
    color: "var(--ink)",
    font: "inherit",
    padding: "7px 10px",
    width: "100%",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--canvas) 75%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 440,
          background: "var(--canvas)",
          border: "1px solid var(--structure-strong)",
          borderRadius: "var(--r)",
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            color: "var(--ink-faint)",
            marginBottom: 14,
          }}
        >
          PROVIDERS — SET UP AGENT PROFILE
        </div>

        {host.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 8 }}>
              Credentials already on this Mac (used in place, never copied):
            </div>
            {host.map((h) => (
              <div
                key={h.providerSlug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 0",
                  borderTop: "1px solid var(--structure)",
                  fontSize: 12,
                }}
              >
                <span style={{ flex: 1 }}>
                  {h.providerSlug}
                  <span style={{ color: "var(--ink-faint)", fontSize: 10, marginLeft: 8 }}>
                    {h.isOauth ? "oauth session" : "api key"}
                    {h.isAmbient ? " · ambient" : ""}
                  </span>
                </span>
                <button className="btn" disabled={busy} onClick={() => void useHost(h)}>
                  Use
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 8 }}>
          Or add an API key (stored in the macOS Keychain):
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <select style={field} value={slug} onChange={(e) => setSlug(e.target.value)}>
            {SLUGS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            style={field}
            placeholder="label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            style={field}
            placeholder="model id (optional, e.g. claude-sonnet-5)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <input
            ref={keyRef}
            style={field}
            type="password"
            placeholder="API key"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void addKey()}>
              {busy ? "Saving…" : "Save & set default"}
            </button>
          </div>
        </div>

        {err && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--danger)" }}>{err}</div>
        )}

        <VoiceSetup />
      </div>
    </div>
  );
}
