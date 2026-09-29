// Pinned to the same timezone and transition as calendar-math-dst.test.ts: Africa/Cairo springs
// forward *at* 00:00 on 2026-04-24, jumping from +02:00 to +03:00, so the offset isoWithOffset
// writes must flip exactly at that instant rather than lag a fixed +02:00 all year.
process.env.TZ = 'Africa/Cairo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWithOffset } from '../../src/core/tasks.ts';

test('isoWithOffset reports the pre-transition standard offset the evening before', () => {
  assert.equal(isoWithOffset(new Date(2026, 3, 23, 23, 0, 0)), '2026-04-23T23:00:00+02:00');
});

test('isoWithOffset reports the post-transition DST offset just after the skipped midnight', () => {
  // Local midnight itself never exists that day (Date normalizes 2026-04-24 00:00 forward to
  // 01:00, exactly as calendar-math-dst.test.ts's msUntilLocalMidnight case demonstrates), so
  // the earliest representable moment on the 24th is already +03:00.
  assert.equal(isoWithOffset(new Date(2026, 3, 24, 1, 0, 0)), '2026-04-24T01:00:00+03:00');
});

test('isoWithOffset pads single-digit month, day, hour, minute and second fields', () => {
  assert.equal(isoWithOffset(new Date(2026, 0, 5, 3, 4, 5)), '2026-01-05T03:04:05+02:00');
});
