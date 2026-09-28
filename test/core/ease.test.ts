import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeOutCubic, lerp } from '../../src/core/ease.ts';

test('lerp: endpoints and midpoint', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(4, 4, 0.7), 4); // a === b: any t returns a (=== b)
});

test('easeOutCubic: endpoints', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test('easeOutCubic: clamps outside [0, 1]', () => {
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
});

test('easeOutCubic: ease-out shape — ahead of linear through the middle of the curve', () => {
  // Ease-out means most of the motion happens early: at the midpoint, progress should be
  // further along than a plain linear ramp would be.
  assert.ok(easeOutCubic(0.5) > 0.5);
});

test('easeOutCubic: monotonically non-decreasing', () => {
  let previous = 0;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const value = easeOutCubic(t);
    assert.ok(value >= previous - 1e-12, `value dropped from ${previous} to ${value} at t=${t}`);
    previous = value;
  }
});
