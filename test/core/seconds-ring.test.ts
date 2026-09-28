import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendTickAlpha, ringTicks, tickAlpha } from '../../src/core/seconds-ring.ts';

// Independent check that a point lies on the rounded rect's boundary: the signed-distance
// function for a rounded box (Inigo Quilez's sdRoundedBox), evaluated relative to the rect's own
// centre. 0 means exactly on the edge; this doesn't reuse ringTicks's own segment-walking code,
// so it actually catches a geometry bug rather than restating the implementation.
function roundedBoxSd(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  return Math.hypot(mx, my) + Math.min(Math.max(qx, qy), 0) - r;
}

const W = 200;
const H = 200;
const INSET = 20;
const RADIUS = 10;
const HW = W / 2 - INSET;
const HH = H / 2 - INSET;
const CX = W / 2;
const CY = H / 2;

test('ringTicks places exactly `count` ticks', () => {
  assert.equal(ringTicks(W, H, INSET, RADIUS).length, 60);
  assert.equal(ringTicks(W, H, INSET, RADIUS, 12).length, 12);
});

test('tick 0 sits at top-centre', () => {
  const [first] = ringTicks(W, H, INSET, RADIUS);
  assert.ok(first);
  assert.ok(Math.abs(first.x1 - CX) < 1e-9);
  assert.ok(Math.abs(first.y1 - (CY - HH)) < 1e-9);
});

test('ticks 15, 30, 45 sit at right/bottom/left-centre for a square', () => {
  const ticks = ringTicks(W, H, INSET, RADIUS, 60);
  const right = ticks[15]!;
  const bottom = ticks[30]!;
  const left = ticks[45]!;
  assert.ok(Math.abs(right.x1 - (CX + HW)) < 1e-6 && Math.abs(right.y1 - CY) < 1e-6);
  assert.ok(Math.abs(bottom.x1 - CX) < 1e-6 && Math.abs(bottom.y1 - (CY + HH)) < 1e-6);
  assert.ok(Math.abs(left.x1 - (CX - HW)) < 1e-6 && Math.abs(left.y1 - CY) < 1e-6);
});

test('every tick lies on the rounded-rect path', () => {
  const ticks = ringTicks(W, H, INSET, RADIUS, 60);
  for (const t of ticks) {
    const d = roundedBoxSd(t.x1 - CX, t.y1 - CY, HW, HH, RADIUS);
    assert.ok(Math.abs(d) < 1e-6, `outer point off the path by ${d}`);
  }
});

test('arc-length spacing is equal on a circle (a degenerate rounded rect)', () => {
  // hw === hh === r collapses the rounded rect into a plain circle, where equal arc-length
  // spacing is also equal-chord spacing — an exact, independently-checkable case.
  const size = 100;
  const r = size / 2;
  const ticks = ringTicks(size, size, 0, r, 24, 4);
  const chord = (a: typeof ticks[number], b: typeof ticks[number]) => Math.hypot(b.x1 - a.x1, b.y1 - a.y1);
  const chords = ticks.map((t, i) => chord(t, ticks[(i + 1) % ticks.length]!));
  const [first] = chords;
  assert.ok(first !== undefined);
  for (const c of chords)
    assert.ok(Math.abs(c - first!) < 1e-9, `chord ${c} differs from ${first}`);
});

test('tick normals point inward', () => {
  const ticks = ringTicks(W, H, INSET, RADIUS, 60, 6);
  for (const t of ticks) {
    const outer = Math.hypot(t.x1 - CX, t.y1 - CY);
    const inner = Math.hypot(t.x2 - CX, t.y2 - CY);
    assert.ok(inner < outer, `inner end (${inner}) is not closer to centre than outer (${outer})`);
  }
});

test('tickAlpha: the current tick is fully bright', () => {
  assert.equal(tickAlpha(37, 37), 1);
});

test('tickAlpha: the tick just ahead of the current second is at the minimum', () => {
  // i = second + 1 (mod 60): the single darkest tick, next in line to become current.
  // d = 59 is the maximum possible age, so t = (59-36)/23 = 1 and the eased curve bottoms out
  // exactly at MIN_ALPHA.
  assert.ok(Math.abs(tickAlpha(38, 37) - 0.12) < 1e-9);
});

test('tickAlpha: recently-passed ticks stay fully bright', () => {
  assert.equal(tickAlpha(36, 37), 1); // d=1
  assert.equal(tickAlpha(1, 37), 1); // d=36: the last fully-bright step before the fade begins
});

test('tickAlpha: monotonic non-increasing along the fade', () => {
  const second = 10;
  let previous = 1; // d=36 (the last fully-bright step) is 1; the fade only starts after it.
  for (let d = 37; d <= 59; d++) {
    const i = ((second - d) % 60 + 60) % 60;
    const alpha = tickAlpha(i, second);
    assert.ok(alpha <= previous + 1e-9, `alpha rose from ${previous} to ${alpha} at d=${d}`);
    previous = alpha;
  }
});

test('tickAlpha: at least half the fading tail is clearly dark (below 0.4)', () => {
  // Regression guard for the "too weak to read" complaint: a *linear* fade over the same
  // MIN_ALPHA/FADE_LEN would put only ~8 of these 23 ticks below 0.4 (well under half) — this
  // only passes because the curve is eased, dropping away faster than linear once t is past its
  // early, still-near-bright stretch.
  const second = 0;
  let dark = 0;
  let total = 0;
  for (let d = 37; d <= 59; d++) {
    total++;
    const i = ((second - d) % 60 + 60) % 60;
    if (tickAlpha(i, second) < 0.4)
      dark++;
  }
  assert.ok(dark >= total / 2, `only ${dark}/${total} faded ticks are below 0.4`);
});

test('tickAlpha: alpha is clamped to [MIN_ALPHA, 1]', () => {
  for (let i = 0; i < 60; i++)
    for (const second of [0, 1, 30, 59]) {
      const alpha = tickAlpha(i, second);
      assert.ok(alpha >= 0.12 - 1e-9 && alpha <= 1 + 1e-9, `alpha ${alpha} out of range`);
    }
});

test('tickAlpha: the second/index modulo wraps correctly', () => {
  // second=0, i=59 → d = (0 - 59 + 60) % 60 = 1: just passed, still bright.
  assert.equal(tickAlpha(59, 0), 1);
  // second=59, i=0 → d = (59 - 0 + 60) % 60 = 59: the darkest tick, at the minimum.
  assert.ok(Math.abs(tickAlpha(0, 59) - 0.12) < 1e-9);
});

// A non-square rounded rect, with straight runs of visibly different lengths on its two axes.
// The earlier square case (W=H=200) can't tell "wrong per-corner arc length" apart from "right
// answer": a square's fourfold symmetry means a *consistent* corner-length error still lands
// ticks 15/30/45 exactly on the side midpoints (each quarter of the ring is still identical to
// the others, just not identical to arc length/60 in absolute terms). A non-square rect breaks
// that symmetry, so a wrong constant for the quarter-circle length (e.g. 3r instead of the
// correct (pi/2) r) shows up as unequal spacing between straight-run ticks and corner ticks.
const W2 = 282;
const H2 = 116;
const INSET2 = 8;
const RADIUS2 = 12;
const HW2 = W2 / 2 - INSET2;
const HH2 = H2 / 2 - INSET2;

// Maps a boundary point (dx, dy — relative to the rect's own centre) to its arc-length position,
// measured clockwise from the top edge's own start (-hw+r, -hh). This mirrors the *convention*
// ringTicks uses (tick 0 sits mid-way along the first segment it walks) only so the two are
// comparable; every length here is recomputed from each piece's own standard closed-form
// (straight run = axis distance, quarter-circle length = (pi/2) r) rather than by calling into
// ringTicks's internal segment table, so a wrong constant in that table is actually caught here,
// not just re-affirmed.
function arcLength(dx: number, dy: number, hw: number, hh: number, r: number): number {
  const sx = hw - r;
  const sy = hh - r;
  const quarter = (Math.PI / 2) * r;
  const topLen = 2 * sx;
  const sideLen = 2 * sy;
  const EPS = 1e-6;

  if (Math.abs(dy - -hh) < EPS && dx >= -sx - EPS && dx <= sx + EPS)
    return dx + sx;
  if (Math.abs(dy - hh) < EPS && dx >= -sx - EPS && dx <= sx + EPS)
    return topLen + quarter + sideLen + quarter + (sx - dx);
  if (Math.abs(dx - hw) < EPS && dy >= -sy - EPS && dy <= sy + EPS)
    return topLen + quarter + (dy + sy);
  if (Math.abs(dx - -hw) < EPS && dy >= -sy - EPS && dy <= sy + EPS)
    return 2 * topLen + sideLen + 3 * quarter + (sy - dy);

  const corners: Array<{ cx: number; cy: number; start: number; base: number }> = [
    { cx: hw - r, cy: -hh + r, start: -Math.PI / 2, base: topLen },
    { cx: hw - r, cy: hh - r, start: 0, base: topLen + quarter + sideLen },
    { cx: -hw + r, cy: hh - r, start: Math.PI / 2, base: 2 * topLen + sideLen + 2 * quarter },
    { cx: -hw + r, cy: -hh + r, start: Math.PI, base: 2 * topLen + 2 * sideLen + 3 * quarter },
  ];
  for (const c of corners) {
    const rx = dx - c.cx;
    const ry = dy - c.cy;
    if (Math.abs(Math.hypot(rx, ry) - r) < 1e-6) {
      let delta = Math.atan2(ry, rx) - c.start;
      while (delta < -EPS)
        delta += 2 * Math.PI;
      if (delta <= Math.PI / 2 + 1e-3)
        return c.base + r * delta;
    }
  }
  throw new Error(`point (${dx}, ${dy}) is not on any of the 8 boundary pieces`);
}

test('arc-length spacing is exactly perimeter/60 on a non-square rounded rect', () => {
  const ticks = ringTicks(W2, H2, INSET2, RADIUS2, 60, 4);
  const sx = HW2 - RADIUS2;
  const sy = HH2 - RADIUS2;
  const perimeter = 2 * (2 * sx) + 2 * (2 * sy) + 4 * (Math.PI / 2) * RADIUS2;
  const expected = perimeter / 60;

  for (const t of ticks) {
    const d = roundedBoxSd(t.x1 - W2 / 2, t.y1 - H2 / 2, HW2, HH2, RADIUS2);
    assert.ok(Math.abs(d) < 1e-6, `outer point off the path by ${d}`);
  }

  const positions = ticks.map(t => arcLength(t.x1 - W2 / 2, t.y1 - H2 / 2, HW2, HH2, RADIUS2));
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i]!;
    const next = positions[(i + 1) % positions.length]!;
    const gap = ((next - cur) % perimeter + perimeter) % perimeter;
    assert.ok(Math.abs(gap - expected) < 1e-6, `gap ${gap} at tick ${i} != expected ${expected}`);
  }
});

test('blendTickAlpha: continuous at both ends of the animation leg, and monotonic toward the target', () => {
  const from = 0.2;
  const i = 10;
  const toSecond = 5;
  const target = tickAlpha(i, toSecond);
  assert.ok(Math.abs(target - from) > 0.01, 'test needs from !== target to be meaningful');

  // progress=0: exactly the snapshot (easeOutCubic(0) = 0, so the blend starts from `from`, not
  // partway toward the target) - a real discontinuity here would show up as a visible jump the
  // instant a new leg starts.
  assert.equal(blendTickAlpha(from, i, toSecond, 0), from);
  // progress=1: exactly the target, matching what _alphaFor falls back to once the timeline (and
  // therefore _fromAlphas) is gone.
  assert.equal(blendTickAlpha(from, i, toSecond, 1), target);
  // Just below progress=1, the blend must sit arbitrarily close to `target`, not jump to it -
  // i.e. the settled value (read once the timeline's 'completed' handler clears _fromAlphas) is
  // continuous with the last still-animating frame, not a discontinuous snap.
  const justBelow = blendTickAlpha(from, i, toSecond, 1 - 1e-6);
  assert.ok(Math.abs(justBelow - target) < 1e-3, `expected close to ${target}, got ${justBelow}`);

  // Monotonic march from `from` toward `target` as progress rises (easeOutCubic is itself
  // monotonic on [0, 1], so the blend can't overshoot or double back).
  let previous = from;
  for (let p = 0.1; p <= 1; p += 0.1) {
    const value = blendTickAlpha(from, i, toSecond, p);
    if (target >= from)
      assert.ok(value >= previous - 1e-9, `value dropped from ${previous} to ${value} at progress ${p}`);
    else
      assert.ok(value <= previous + 1e-9, `value rose from ${previous} to ${value} at progress ${p}`);
    previous = value;
  }
});

test('L-size corner ticks capped at half the radius stay clear of the corner centre', () => {
  // The widget's L geometry: 314×314 drawing area, ring 6px in, corner radius 15, tick length
  // capped at radius/2 (seconds-ring.ts). A longer tick reaches the corner centre and fuses
  // with its neighbour into a V.
  const size = 314;
  const inset = 6;
  const r = 15;
  const ticks = ringTicks(size, size, inset, r, 60, r / 2);
  const c = inset + r;
  const centres = [[c, c], [size - c, c], [size - c, size - c], [c, size - c]] as const;
  for (const t of ticks) {
    const nearest = Math.min(...centres.map(([x, y]) => Math.hypot(t.x2 - x, t.y2 - y)));
    assert.ok(nearest >= r / 2 - 1e-6, `inner end ${nearest.toFixed(2)}px from a corner centre`);
  }
  for (let i = 0; i < ticks.length; i++) {
    const a = ticks[i]!;
    const b = ticks[(i + 1) % ticks.length]!;
    assert.ok(Math.hypot(a.x2 - b.x2, a.y2 - b.y2) > 3.25, `ticks ${i} and ${i + 1} fuse at their inner ends`);
  }
});
