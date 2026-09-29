// Pinned to a fixed-offset zone (no DST) so the expected offset never depends on the date
// picked, unlike calendar-math-dst.test.ts and tasks-dst.test.ts, which are pinned specifically
// to catch a DST transition.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWithOffset } from '../../src/core/tasks.ts';

test('isoWithOffset writes +00:00 in UTC', () => {
  assert.equal(isoWithOffset(new Date(2026, 5, 15, 12, 30, 45)), '2026-06-15T12:30:45+00:00');
});
