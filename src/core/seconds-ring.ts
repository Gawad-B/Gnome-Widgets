// Seconds-ring geometry for the digital clock: 60 tick marks placed at equal
// arc-length spacing around a rounded rectangle, plus the per-tick fade that makes the current
// second read as a bright dot at the head of a trail. Pure TypeScript, no gi imports, so both
// halves are unit-tested under Node.
import { easeOutCubic, lerp } from './ease.ts';

export interface Tick {
  // The outer end sits on the rounded-rect path; the inner end is `length` further along the
  // inward normal, so the pair reads as a short mark perpendicular to the edge.
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface StraightSeg { kind: 'top' | 'right' | 'bottom' | 'left'; len: number }
interface CornerSeg { kind: 'corner'; len: number; cx: number; cy: number; start: number }
type Seg = StraightSeg | CornerSeg;

// The rounded rect's boundary as 8 segments (4 straight sides, 4 quarter-circle corners), in
// clockwise order starting just after the top-left corner (i.e. at the top edge's own start).
// hw/hh are the half-width/half-height of the rect (already inset), r is the corner radius
// (clamped to fit both).
function segments(hw: number, hh: number, r: number): Seg[] {
  const sx = Math.max(0, hw - r); // half-length of the top/bottom straight run
  const sy = Math.max(0, hh - r); // half-length of the left/right straight run
  const quarter = (Math.PI / 2) * r;
  return [
    { kind: 'top', len: 2 * sx },
    { kind: 'corner', len: quarter, cx: hw - r, cy: -hh + r, start: -Math.PI / 2 },
    { kind: 'right', len: 2 * sy },
    { kind: 'corner', len: quarter, cx: hw - r, cy: hh - r, start: 0 },
    { kind: 'bottom', len: 2 * sx },
    { kind: 'corner', len: quarter, cx: -hw + r, cy: hh - r, start: Math.PI / 2 },
    { kind: 'left', len: 2 * sy },
    { kind: 'corner', len: quarter, cx: -hw + r, cy: -hh + r, start: Math.PI },
  ];
}

// The boundary point at arc length `s` from the path's own origin (the top edge's start),
// plus the inward unit normal there. Coordinates are relative to the rect's centre.
function pointAt(segs: readonly Seg[], s: number, hw: number, hh: number, r: number) {
  let remaining = s;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.len <= 0)
      continue;
    const rest = segs.slice(i + 1);
    const isLast = rest.every(other => other.len <= 0);
    if (remaining <= seg.len || isLast) {
      const t = Math.min(Math.max(remaining, 0), seg.len);
      switch (seg.kind) {
        case 'top': return { x: -hw + r + t, y: -hh, nx: 0, ny: 1 };
        case 'right': return { x: hw, y: -hh + r + t, nx: -1, ny: 0 };
        case 'bottom': return { x: hw - r - t, y: hh, nx: 0, ny: -1 };
        case 'left': return { x: -hw, y: hh - r - t, nx: 1, ny: 0 };
        case 'corner': {
          const theta = seg.start + (seg.len > 0 ? t / seg.len : 0) * (Math.PI / 2);
          return {
            x: seg.cx + r * Math.cos(theta), y: seg.cy + r * Math.sin(theta),
            nx: -Math.cos(theta), ny: -Math.sin(theta),
          };
        }
      }
    }
    remaining -= seg.len;
  }
  // Unreachable (the loop always matches on its last live segment); keeps this total for TS.
  return { x: -hw + r, y: -hh, nx: 0, ny: 1 };
}

// Places `count` ticks at equal arc-length spacing along a rounded rectangle inset from a
// w×h drawing area by `inset`, with corner radius `cornerRadius` (clamped to fit the inset
// rect). Tick 0 sits at top-centre; ticks go clockwise, matching a clock face. Coordinates are
// in the drawing area's own frame (origin at its top-left corner), ready for Cairo.
export function ringTicks(
  w: number, h: number, inset: number, cornerRadius: number, count = 60, length = 8,
): Tick[] {
  const hw = Math.max(0, w / 2 - inset);
  const hh = Math.max(0, h / 2 - inset);
  const r = Math.max(0, Math.min(cornerRadius, hw, hh));
  const segs = segments(hw, hh, r);
  const perimeter = segs.reduce((sum, seg) => sum + seg.len, 0);
  if (perimeter <= 0 || count <= 0)
    return [];
  const offset = Math.max(0, hw - r); // arc length from the path origin to top-centre
  const cx = w / 2;
  const cy = h / 2;
  const ticks: Tick[] = [];
  for (let i = 0; i < count; i++) {
    const s = ((offset + (i / count) * perimeter) % perimeter + perimeter) % perimeter;
    const p = pointAt(segs, s, hw, hh, r);
    ticks.push({
      x1: cx + p.x, y1: cy + p.y,
      x2: cx + p.x + p.nx * length, y2: cy + p.y + p.ny * length,
    });
  }
  return ticks;
}

// How many of the trailing ticks fade, and how far down. Widened from an earlier 20/0.15: at
// those values, live testing showed half the tail still reading above 0.55 (effectively still
// "bright white" to the eye) with only the last couple of ticks actually dark. FADE_LEN=24 and
// MIN_ALPHA=0.12, combined with the eased curve below, put most of the tail clearly below 0.4
// (see the "at least half the fading tail is clearly dark" test).
const FADE_LEN = 24;
const MIN_ALPHA = 0.12;

// tickAlpha: `d` is how many seconds ago tick `i` was the current second (0 = current, wrapping
// through `count`). The current tick and the ones just behind it are fully bright; the last
// ~`FADE_LEN` of them — the ones just ahead of the current second, about to be reached next —
// ease down to MIN_ALPHA, giving the ring a bright trail with a clearly dark tail that brightens
// back up the further you get from the current tick (i.e. the closer you get back around to it
// from behind).
//
// The curve is eased (`MIN + (1 - MIN) * (1 - t)²`), not linear: t=0 sits right at the bright
// plateau's edge (eased value ≈ 1, so the transition itself still reads smooth, no visible seam)
// and the curve then drops away faster as t→1, so most of the tail sits close to MIN_ALPHA
// instead of spending half its length still looking bright.
export function tickAlpha(i: number, second: number, count = 60): number {
  const d = ((second - i) % count + count) % count;
  const start = count - FADE_LEN;
  if (d <= start)
    return 1;
  const t = (d - start) / (FADE_LEN - 1);
  const eased = 1 - t; // 1 at the bright edge (t=0), 0 at the darkest tick (t=1)
  const alpha = MIN_ALPHA + (1 - MIN_ALPHA) * eased * eased;
  return Math.min(1, Math.max(MIN_ALPHA, alpha));
}

// The alpha to actually paint tick `i` with mid-animation: an eased blend from `from` (a
// snapshot of what was on screen when the current animation leg started) towards tickAlpha's own
// target for `toSecond`, given the Clutter timeline's raw, linear 0..1 `progress`. Pulled out of
// widgets/clock/seconds-ring.ts's `_alphaFor` (the only gi-dependent part there is reading the
// timeline's progress and calling this) so the blend itself — including the exact continuity at
// progress 0 and 1 — is unit-tested under Node.
export function blendTickAlpha(from: number, i: number, toSecond: number, progress: number): number {
  const target = tickAlpha(i, toSecond);
  const eased = easeOutCubic(progress);
  if (eased >= 1)
    return target;
  return lerp(from, target, eased);
}
