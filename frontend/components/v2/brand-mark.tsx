/*
 * THE REVERIE MARK — Seam.
 *
 * One disc, split across its equator, the halves displaced. The seam is the
 * idea: the same subject recorded twice and no longer lining up.
 *
 * OPTICAL SIZES, NOT JUST SCALE. A 1.8-unit seam on a 32-unit grid is 0.9px at
 * 16px, which on a 1x display is not there — so below 24px the halves move
 * further apart and the seam widens. The drawing changes so the impression
 * does not, the way a typeface has a caption cut. The mark this replaced kept
 * one drawing and varied stroke weight, and was illegible at 14, 18 and 22px.
 *
 * The full study, including the four directions that lost, is in
 * docs/ui-redesign/ (V2 review PDF, sections 05-06).
 */

const R = 10; /* radius of each half, on a 32-unit grid */

function geometry(size: number): { d: number; g: number } {
  if (size <= 22) return { d: 3.9, g: 1.35 };
  if (size <= 30) return { d: 3.6, g: 1.1 };
  return { d: 3.4, g: 0.9 };
}

export interface BrandMarkProps {
  /** Rendered px. Drives the optical size, not just the scale. */
  size?: number;
  className?: string;
  /** Give it an accessible name where it is the only thing identifying Reverie. */
  title?: string;
}

export function BrandMark({ size = 18, className, title }: BrandMarkProps) {
  const { d, g } = geometry(size);
  const top = `M${16 + d - R} ${16 - g} A${R} ${R} 0 0 1 ${16 + d + R} ${16 - g} Z`;
  const bottom = `M${16 - d + R} ${16 + g} A${R} ${R} 0 0 1 ${16 - d - R} ${16 + g} Z`;

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={top} fill="currentColor" />
      <path d={bottom} fill="currentColor" />
    </svg>
  );
}

/**
 * The mark performing its own meaning: the halves slide apart and come back
 * together. Reconciliation, which is what Reverie is doing while you wait.
 *
 * Under prefers-reduced-motion the animation is absent rather than slowed —
 * see the media query in globals.css — and whatever text sits beside it is
 * what says "working".
 */
export function BrandMarkWorking({ size = 18, className }: BrandMarkProps) {
  return (
    <span className={className} data-working>
      <BrandMark size={size} className="[&>path:first-child]:animate-[seam-a_1.6s_var(--ease)_infinite] [&>path:last-child]:animate-[seam-b_1.6s_var(--ease)_infinite]" />
      <style>{`
        @keyframes seam-a { 0%,100% { transform: translateX(0) } 40% { transform: translateX(2.4px) } }
        @keyframes seam-b { 0%,100% { transform: translateX(0) } 40% { transform: translateX(-2.4px) } }
      `}</style>
    </span>
  );
}
