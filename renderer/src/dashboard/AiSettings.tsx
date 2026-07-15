// PR 10: bring-your-own-model settings — a compact popover off the NEXT MOVES
// section header. One OpenAI-compatible endpoint shape covers every provider
// preset; the planner does all math, so small models suffice (the hint says
// so verbatim). KEY HYGIENE: the password field's transient draft is the only
// key the renderer ever holds — the store keeps hasKey (a boolean), the GET
// view never echoes the key, and saving with an empty draft means "unchanged".
//
// Review M7/L5: the popover's open flag lives in the STORE (aiSettingsOpen)
// so App's capture-phase Escape handler can defer to it — popover closes
// first, the dashboard under it survives the keystroke. Outside clicks land
// on a transparent scrim (house grammar — same idiom as the dashboard's own
// scrim, no document-level listener to leak).

import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { AiSettingsContext } from "../state/types";

const PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { label: "Custom", baseUrl: "" },
] as const;

/** Save-time base-URL check. `new URL("localhost:11434/v1")` PARSES — with
 *  protocol "localhost:" — so the likeliest paste mistake needs the explicit
 *  http/https protocol check, not just a parse. Empty base is exempt: it is
 *  the documented clear gesture. Returns the inline error, or null when ok. */
const urlProblem = (base: string): string | null => {
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `URL must start with http:// or https:// — got "${u.protocol}"`;
    }
    return null;
  } catch {
    return "not a valid URL — e.g. https://api.openai.com/v1";
  }
};

/** True when the base would send the API key in cleartext to a non-local
 *  host — http:// is fine for localhost (Ollama/LM Studio), a warning
 *  everywhere else. */
const cleartextRisk = (base: string): boolean => {
  if (!base.startsWith("http://")) return false;
  try {
    const host = new URL(base).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false; // unparseable — the save-time check owns that complaint
  }
};

export default function AiSettings({
  onSaved,
  context,
}: {
  onSaved: () => void;
  context: AiSettingsContext;
}) {
  const aiConfig = useStore((s) => s.aiConfig);
  const fetchAiConfig = useStore((s) => s.fetchAiConfig);
  const saveAiConfig = useStore((s) => s.saveAiConfig);
  // M7: store-held so App's Escape handler can close the popover first. M2:
  // the flag is context-scoped — this instance is open only when it owns the
  // flag, so the sibling header's <AiSettings/> can't cross-wire it.
  const open = useStore((s) => s.aiSettingsOpen === context);
  const setAiSettingsOpen = useStore((s) => s.setAiSettingsOpen);
  const close = () => setAiSettingsOpen(null);
  const toggle = () => setAiSettingsOpen(open ? null : context);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  /** transient — cleared on every close path, never stored anywhere else */
  const [keyDraft, setKeyDraft] = useState("");
  /** sticky Custom: once picked, the select never snaps back to a preset the
      typed URL happens to match (and picking it never clears the URL). */
  const [customPicked, setCustomPicked] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    void fetchAiConfig();
  }, [fetchAiConfig]);

  // The deference flag must not leak: the dashboard unmounts this component
  // wholesale (overlay close, plan switch), and a stale flag would make App's
  // next Escape a silent no-op layer. M2: clear ONLY if this instance still
  // owns the flag, so unmounting one header never slams the sibling's open
  // popover shut.
  useEffect(
    () => () => {
      if (useStore.getState().aiSettingsOpen === context) useStore.getState().setAiSettingsOpen(null);
    },
    [context],
  );

  // Key hygiene: whichever way the popover closes (CLOSE, save, Escape,
  // scrim click), the transient key draft dies with it.
  useEffect(() => {
    if (!open) setKeyDraft("");
  }, [open]);

  // Seed the form from the fetched config ONCE (not on every refetch, which
  // would clobber in-progress typing).
  useEffect(() => {
    if (aiConfig && !seeded.current) {
      seeded.current = true;
      setBaseUrl(aiConfig.baseUrl);
      setModel(aiConfig.model);
    }
  }, [aiConfig]);

  const preset = customPicked ? "Custom" : (PRESETS.find((p) => p.baseUrl === baseUrl)?.label ?? "Custom");

  const save = async () => {
    const base = baseUrl.trim();
    const problem = urlProblem(base);
    if (problem) {
      setUrlError(problem);
      return; // popover stays open, nothing saved
    }
    const ok = await saveAiConfig({
      baseUrl: base,
      model: model.trim(),
      // omit apiKey entirely when untouched → backend keeps the stored key
      ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}),
    });
    if (ok) {
      setKeyDraft("");
      close();
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
        onClick={toggle}
      >
        ⚙ {chipLabel}
      </button>
      {open && (
        // Transparent scrim one z under the pop: outside clicks close it
        // without a document listener and without activating what's beneath.
        <div className="dash-ai-scrim" data-testid="ai-scrim" onClick={close} />
      )}
      {open && (
        <div
          className="dash-ai-pop"
          data-testid="ai-settings"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Focus inside a field: App's window handler yields at
            // isEditableTarget, so the popover owns that Escape itself.
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
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
                if (!p) return;
                if (p.label === "Custom") {
                  setCustomPicked(true); // keep whatever URL is typed
                } else {
                  setCustomPicked(false);
                  setBaseUrl(p.baseUrl);
                  setUrlError(null);
                }
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
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setUrlError(null); // stale complaint never outlives an edit
              }}
            />
          </div>
          {urlError && (
            <div className="dash-ai-url-error mono" data-testid="ai-url-error">
              {urlError}
            </div>
          )}
          {cleartextRisk(baseUrl.trim()) && (
            <div className="dash-ai-cleartext mono" data-testid="ai-cleartext-hint">
              http:// beyond localhost sends the API key in cleartext
            </div>
          )}
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
            <button className="btn btn-ghost" onClick={close}>
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
