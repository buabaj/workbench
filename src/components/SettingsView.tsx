import { useEffect, useRef, useState } from "react";
import { PreflightPanel } from "./Preflight";
import { formatError, ipc, type AgentModel, type CredentialProfileView, type HostAuthSummary } from "../ipc/client";
import { useChat } from "../store/chat";
import { useTheme, type ThemeChoice } from "../store/theme";
import { useWorkspace } from "../store/workspace";

const SLUGS = [
  "anthropic",
  "openai",
  "openai-codex",
  "openrouter",
  "prime-inference",
  "kimi-coding",
  "google",
];

/** Native selects can't be styled to match; this is a small listbox that can. */
function Select({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="field"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", width: "100%", textAlign: "left" }}
      >
        <span style={{ flex: 1 }}>{current?.label ?? value}</span>
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden style={{ color: "var(--ink-faint)" }}>
          <path d="M2.5 4.2l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--canvas)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-input)",
            boxShadow: "var(--lift)",
            padding: 4,
            zIndex: 20,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          {options.map((o) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--r-control)",
                fontSize: "var(--text-sm)",
                background: o.value === value ? "var(--clay-wash)" : "transparent",
                cursor: "default",
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--s-10)" }}>
      <h2
        style={{
          fontFamily: "var(--serif)",
          fontVariationSettings: "var(--serif-settings)",
          fontSize: "var(--text-lg)",
          fontWeight: 500,
          marginBottom: "var(--s-3)",
          letterSpacing: "var(--track-snug)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: "var(--s-4)",
        alignItems: "start",
        padding: "var(--s-3) 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div>
        <div style={{ fontSize: "var(--text-sm)" }}>{label}</div>
        {hint && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", marginTop: 2 }}>{hint}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SettingsView() {
  const themeChoice = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);
  const workspace = useWorkspace((s) => s.workspace);
  const refreshProfile = useChat((s) => s.refreshProfile);

  const [creds, setCreds] = useState<CredentialProfileView[]>([]);
  const [host, setHost] = useState<HostAuthSummary[]>([]);
  const [voiceLabel, setVoiceLabel] = useState<string | null>(null);
  const [slug, setSlug] = useState("anthropic");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    setCreds(await ipc.credsList().catch(() => []));
    setHost(await ipc.credsDiscoverHostAuth().catch(() => []));
    const cap = await ipc.voiceCapability().catch(() => null);
    setVoiceLabel(cap?.configured ? (cap.credentialLabel ?? "configured") : null);
  };

  useEffect(() => {
    void reload();
  }, []);

  const setup = async (opts: {
    label: string;
    authKind: "api_key" | "oauth_host";
    providerSlug: string;
    apiKey?: string;
    modelId?: string;
  }) => {
    setBusy(true);
    setErr(null);
    try {
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
      await refreshProfile(workspace?.id ?? null);
      await reload();
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  /** Ask the agent which models this credential can actually reach. Without an
   * explicit model, prime-agent falls back to a default that may belong to a
   * DIFFERENT provider — which is how work got billed to the wrong account. */
  const [modelsFor, setModelsFor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const chooseModel = async (credentialId: string, modelId: string) => {
    try {
      await ipc.agentProfileSetModel(credentialId, modelId);
      setChosen(modelId);
      setErr(null);
    } catch (e) {
      setErr(formatError(e));
    }
  };

  const loadModels = async (credentialId: string) => {
    setModelsFor(credentialId);
    setLoadingModels(true);
    try {
      setModels(await ipc.agentListModels(credentialId));
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "var(--s-8) var(--s-6) var(--s-16)" }}>
      <Section title="Appearance">
        <Row label="Theme" hint="System follows macOS.">
          <div style={{ display: "flex", gap: 4 }}>
            {(["light", "dark", "system"] as ThemeChoice[]).map((t) => (
              <button
                key={t}
                className={`btn ${themeChoice === t ? "primary" : ""}`}
                style={{ textTransform: "capitalize", fontSize: "var(--text-sm)" }}
                onClick={() => setTheme(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section title="Providers">
        {/* An API key is billed per token and is entirely separate from a
            ChatGPT or Claude subscription — paying for both is easy to do by
            accident. prime-agent can authenticate against the subscription
            instead, but only after a one-off login on the host, so say so
            here rather than leaving it to be discovered. */}
        {!host.some((h) => h.isOauth) && (
          <Row
            label="Use a subscription"
            hint="Avoids per-token API billing you may already be paying for."
          >
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-muted)", lineHeight: 1.5 }}>
              An API key is metered separately from a ChatGPT Plus/Pro or Claude subscription. To
              bill work to a subscription you already have, run this once in a terminal:
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink)",
                  background: "var(--raised)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-control)",
                  padding: "6px 10px",
                  margin: "var(--s-2) 0",
                  userSelect: "text",
                }}
              >
                prime-agent
              </div>
              then use <span style={{ fontFamily: "var(--mono)" }}>/login</span> and pick your
              subscription. It appears here as an OAuth session, and Workbench uses it in place —
              the tokens are never copied.
            </div>
          </Row>
        )}
        {host.length > 0 && (
          <Row label="On this Mac" hint="Used in place; tokens are never copied.">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {host.map((h) => (
                <div key={h.providerSlug} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-sm)" }}>
                  <span style={{ flex: 1 }}>
                    {h.providerSlug}
                    <span style={{ color: "var(--ink-faint)", fontSize: "var(--text-xs)", marginLeft: 6 }}>
                      {h.isOauth ? "oauth session" : "api key"}
                      {h.isAmbient ? " · ambient" : ""}
                    </span>
                  </span>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void setup({
                        label: `${h.providerSlug} (host session)`,
                        authKind: "oauth_host",
                        providerSlug: h.providerSlug,
                      })
                    }
                  >
                    Use
                  </button>
                </div>
              ))}
            </div>
          </Row>
        )}

        <Row label="Add an API key" hint="Stored in the macOS Keychain.">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <Select
              label="Provider"
              value={slug}
              onChange={setSlug}
              options={SLUGS.map((s) => ({ value: s, label: s }))}
            />
            <input
              className="field"
              placeholder="model id (optional)"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <input
              ref={keyRef}
              className="field"
              type="password"
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
            />
            <button
              className="btn primary"
              disabled={busy}
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                const el = keyRef.current;
                if (!el?.value) {
                  setErr("Enter an API key.");
                  return;
                }
                const key = el.value;
                el.value = "";
                void setup({
                  label: `${slug} key`,
                  authKind: "api_key",
                  providerSlug: slug,
                  apiKey: key,
                  modelId: model.trim() || undefined,
                });
              }}
            >
              Save & set as default
            </button>
          </div>
        </Row>

        {creds.length > 0 && (
          <Row label="Saved credentials" hint="Pick a model so work isn't billed to another provider.">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              {creds.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--text-sm)" }}>
                  <span style={{ flex: 1 }}>{c.label}</span>
                  <span style={{ color: "var(--ink-faint)", fontFamily: "var(--mono)", fontSize: 11 }}>
                    {c.keyFingerprint ?? "host"}
                  </span>
                  <button className="btn" style={{ fontSize: "var(--text-xs)" }} disabled={loadingModels}
                          onClick={() => void loadModels(c.id)}>
                    {loadingModels ? "Checking…" : "Models"}
                  </button>
                </div>
              ))}
              {models.length > 0 && modelsFor && (
                <div style={{ marginTop: "var(--s-2)" }}>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)", marginBottom: 4 }}>
                    {models.length} model{models.length === 1 ? "" : "s"} reachable — click one to use it.
                    Context window matters most: a small one truncates the agent mid-task.
                  </div>
                  <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                    {models.slice(0, 60).map((m) => (
                      <button
                        key={`${m.provider}/${m.id}`}
                        className="btn quiet"
                        onClick={() => void chooseModel(modelsFor, m.id)}
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "baseline",
                          width: "100%",
                          justifyContent: "flex-start",
                          fontSize: "var(--text-xs)",
                          fontFamily: "var(--mono)",
                          textAlign: "left",
                          background: chosen === m.id ? "var(--clay-wash)" : undefined,
                        }}
                      >
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{m.id}</span>
                        {m.recommended && chosen !== m.id && (
                          <span style={{ color: "var(--clay-text)", flexShrink: 0 }}>recommended</span>
                        )}
                        {chosen === m.id && (
                          <span style={{ color: "var(--clay-text)", flexShrink: 0 }}>in use</span>
                        )}
                        <span style={{ color: "var(--ink-faint)", flexShrink: 0, minWidth: 52, textAlign: "right" }}>
                          {m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "—"}
                        </span>
                        <span style={{ color: "var(--ink-faint)", flexShrink: 0, minWidth: 56, textAlign: "right" }}>
                          {m.outputCost != null ? `$${m.outputCost}/M` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Row>
        )}

        {err && (
          <div role="alert" style={{ color: "var(--error)", fontSize: "var(--text-sm)", marginTop: "var(--s-2)" }}>
            {err}
          </div>
        )}
      </Section>

      <Section title="Voice">
        <Row label="Transcription" hint="OpenRouter, strict privacy.">
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-muted)" }}>
            {voiceLabel ? (
              <>
                Enabled via <span style={{ color: "var(--ink)" }}>{voiceLabel}</span> — zero-retention,
                no provider fallbacks.
              </>
            ) : (
              "Not configured. Add an OPENROUTER_API_KEY to your .env, or a key above."
            )}
          </div>
        </Row>
      </Section>

      <Section title="Diagnostics">
        <PreflightPanel />
      </Section>
    </div>
  );
}
