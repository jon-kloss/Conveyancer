// Shared typing guard for global keyboard shortcuts + platform-aware key labels.

/** Mac-family platforms show ⌘; everything else shows Ctrl. Handlers already
 *  accept BOTH (`e.metaKey || e.ctrlKey`) — this only fixes what we DISPLAY,
 *  so a Windows/Linux planner isn't told to press a key their keyboard lacks. */
const IS_MAC = /Mac|iP(hone|ad|od)/i.test(
  // userAgentData is the modern source; platform still ships everywhere.
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent,
);

/** "⌘K" on Mac, "Ctrl+K" elsewhere. */
export const modKey = (k: string): string => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);

// Input types with a caret: these own native text undo and free typing.
// Range/checkbox/radio/button inputs do NOT belong here — a planner who just
// dragged the target slider still expects ⌘Z to undo the plan, and the slider
// keeps focus after the drag.
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** True when the key event originates from a text-entry / form surface that
 *  owns its own keyboard semantics (native undo, caret moves, option pick). */
export function isEditableTarget(e: Pick<KeyboardEvent, "target">): boolean {
  const t = e.target;
  if (t instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(t.type);
  return (
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
