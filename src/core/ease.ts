// Pure interpolation/easing helpers. Kept separate from any gi import so the per-frame animation
// math in widgets/clock/seconds-ring.ts (which drives a Clutter.Timeline) is unit-testable under
// Node: the widget reads a timeline's linear 0..1 progress and hands it to easeOutCubic itself,
// rather than relying on Clutter's own (untestable, from here) progress-mode easing.

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Ease-out: fast at the start, settling gently at the end. Used for the seconds ring's per-second
// step animation, so a tick's brightness eases into its new value over ~400ms instead of jumping.
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const inv = 1 - clamped;
  return 1 - inv * inv * inv;
}
