// PR 10: bring-your-own-model settings — a compact popover off the NEXT MOVES
// section header. One OpenAI-compatible endpoint shape covers every provider
// preset; the planner does all math, so small models suffice (the hint says
// so verbatim). KEY HYGIENE: the password field's transient draft is the only
// key the renderer ever holds — the store keeps hasKey (a boolean), the GET
// view never echoes the key, and saving with an empty draft means "unchanged".

import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

const PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "Custom", baseUrl: "" },
] as const;

export default function AiSettings({ onSaved }: { onSaved: () => void }) {
  const aiConfig = useStore((s) => s.aiConfig);
  const fetchAiConfig = useStore((s) => s.fetchAiConfig);
  const saveAiConfig = useStore((s) => s.saveAiConfig);
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  /** transient — cleared on save/close, never stored anywhere else */
  const [keyDraft, setKeyDraft] = useState("");
  const seeded = useRef(false);

  useEffect(() => {
    void fetchAiConfig();
  }, [fetchAiConfig]);

  // Seed the form from the fetched config ONCE (not on every refetch, which
  // would clobber in-progress typing).
  useEffect(() => {
    if (aiConfig && !seeded.current) {
      seeded.current = true;
      setBaseUrl(aiConfig.baseUrl);
      setModel(aiConfig.model);
    }
  }, [aiConfig]);

  const preset = PRESETS.find((p) => p.baseUrl === baseUrl)?.label ?? "Custom";

  const save = async () => {
    const ok = await saveAiConfig({
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      // omit apiKey entirely when untouched → backend keeps the stored key
      ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
    });
    if (ok) {
      setKeyDraft("");
      setOpen(false);
      onSaved();
    }
  };

  const chipLabel = aiConfig?.configured ? `AI: ${aiConfig.model}` : "AI: OFF";

  return (
    <span className="dash-ai-wrap">
      <button
        className="chip dash-ai-chip"
        data-testid="ai-chip"
        title="Bring-your-own-model settings — the model ranks and narrates; it never calculates"
        onClick={() => setOpen((o) => !o)}
      >
        ⚙ {chipLabel}
      </button>
      {open && (
        <div className="dash-ai-pop" data-testid="ai-settings" onClick={(e) => e.stopPropagation()}>
          <div className="dash-ai-row">
            <label className="t-label" htmlFor="ai-preset">
              PROVIDER
            </label>
            <select
              id="ai-preset"
              data-testid="ai-preset"
              value={preset}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.label === e.target.value);
                if (p && p.label !== "Custom") setBaseUrl(p.baseUrl);
              }}
            >
              {PRESETS.map((p) => (
                <option key={p.label}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="dash-ai-row">
            <label className="t-label" htmlFor="ai-base-url">
              BASE URL
            </label>
            <input
              id="ai-base-url"
              data-testid="ai-base-url"
              className="mono"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="dash-ai-row">
            <label className="t-label" htmlFor="ai-model">
              MODEL
            </label>
            <input
              id="ai-model"
              data-testid="ai-model"
              className="mono"
              placeholder="gpt-4o-mini"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="dash-ai-row">
            <label className="t-label" htmlFor="ai-key">
              API KEY
            </label>
            <input
              id="ai-key"
              data-testid="ai-key"
              className="mono"
              type="password"
              autoComplete="off"
              placeholder={aiConfig?.hasKey ? "unchanged" : "none — Ollama/LM Studio need no key"}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </div>
          <div className="dash-ai-hint">
            Small/fast models are plenty — the planner does the math; the model does the talking.
          </div>
          <div className="dash-ai-actions">
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>
              CLOSE
            </button>
            <button className="btn btn-primary" data-testid="ai-save" onClick={() => void save()}>
              SAVE
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
