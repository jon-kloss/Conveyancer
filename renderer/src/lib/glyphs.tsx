// MANIFOLD in-app glyph set (brand handoff §2): 24px grid, 1.8px stroke,
// square caps, ink-300 body with orange reserved for the ONE interactive
// accent inside a glyph. Geometry is verbatim from the handoff SVGs; body
// color rides currentColor (callers default to ink-300 via .glyph), the
// accent stays pinned to the signal token. Entity grammar: diamond =
// factory, square = infrastructure.

import type { ReactNode } from "react";

const ACCENT = "var(--signal-500)";

const BODIES: Record<string, ReactNode> = {
  factory: <path d="M12 3 L21 12 L12 21 L3 12 Z" fill="none" stroke="currentColor" strokeWidth="1.8" />,
  built: <path d="M12 3 L21 12 L12 21 L3 12 Z" fill="currentColor" />,
  switch: (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="9.5" y="9.5" width="5" height="5" fill={ACCENT} />
    </>
  ),
  power: (
    <path
      d="M13 2 L7 13 H11.5 L9.5 22 L18 10 H12.5 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="miter"
    />
  ),
  belt: (
    <>
      <rect x="3" y="8.5" width="18" height="7" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8.5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="15.5" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  // Fluid pipe: a tube with two flange joints (vs the belt's rollers).
  pipe: (
    <>
      <rect x="3" y="8.5" width="18" height="7" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <line x1="8.5" y1="7" x2="8.5" y2="17" stroke="currentColor" strokeWidth="1.8" />
      <line x1="15.5" y1="7" x2="15.5" y2="17" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  rail: (
    <>
      <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="1.8" />
      <line x1="7" y1="8" x2="7" y2="16" stroke="currentColor" strokeWidth="1.8" />
      <line x1="12" y1="8" x2="12" y2="16" stroke="currentColor" strokeWidth="1.8" />
      <line x1="17" y1="8" x2="17" y2="16" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  truck: (
    <>
      <rect x="3" y="8" width="11" height="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="14" y="10.5" width="6" height="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8" cy="18" r="1.8" fill="currentColor" />
      <circle cx="17" cy="18" r="1.8" fill="currentColor" />
    </>
  ),
  drone: (
    <>
      <rect x="9.5" y="9.5" width="5" height="5" fill="currentColor" />
      <line x1="10" y1="10" x2="6" y2="6" stroke="currentColor" strokeWidth="1.6" />
      <line x1="14" y1="10" x2="18" y2="6" stroke="currentColor" strokeWidth="1.6" />
      <line x1="10" y1="14" x2="6" y2="18" stroke="currentColor" strokeWidth="1.6" />
      <line x1="14" y1="14" x2="18" y2="18" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="5.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.5" cy="18.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18.5" cy="18.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  wizard: (
    <>
      <path d="M12 8.5 L15.5 12 L12 15.5 L8.5 12 Z" fill={ACCENT} />
      <line x1="12" y1="2.5" x2="12" y2="5.5" stroke="currentColor" strokeWidth="1.6" />
      <line x1="12" y1="18.5" x2="12" y2="21.5" stroke="currentColor" strokeWidth="1.6" />
      <line x1="2.5" y1="12" x2="5.5" y2="12" stroke="currentColor" strokeWidth="1.6" />
      <line x1="18.5" y1="12" x2="21.5" y2="12" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  import: (
    <>
      <line x1="12" y1="3" x2="12" y2="13" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.5 9.5 L12 14 L16.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 16 V20 H20 V16" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  audit: (
    <>
      <rect x="3.5" y="4.5" width="3" height="3" fill="currentColor" />
      <rect x="3.5" y="10.5" width="3" height="3" fill={ACCENT} />
      <rect x="3.5" y="16.5" width="3" height="3" fill="currentColor" />
      <line x1="9.5" y1="6" x2="20.5" y2="6" stroke="currentColor" strokeWidth="1.8" />
      <line x1="9.5" y1="12" x2="20.5" y2="12" stroke="currentColor" strokeWidth="1.8" />
      <line x1="9.5" y1="18" x2="20.5" y2="18" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  advisor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 16.5 L8 21 L12.5 16.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="10.5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="10.5" r="1.2" fill="currentColor" />
      <circle cx="15" cy="10.5" r="1.2" fill="currentColor" />
    </>
  ),
};

export type GlyphName = keyof typeof BODIES;

/** A MANIFOLD UI glyph at 16–24px. Colors: body follows currentColor (the
 *  .glyph class defaults it to ink-300); the in-glyph accent is always
 *  signal-500. */
export default function Glyph({ name, size = 16 }: { name: GlyphName | string; size?: number }) {
  const body = BODIES[name];
  if (!body) return null;
  return (
    <svg className="glyph" viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {body}
    </svg>
  );
}
