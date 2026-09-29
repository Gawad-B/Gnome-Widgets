// America/Bogota is a fixed UTC-05:00 all year (Colombia has not observed DST since 1993), so
// this exercises the negative-offset formatting path without a transition to account for.
process.env.TZ = 'America/Bogota';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWithOffset } from '../../src/core/tasks.ts';

test('isoWithOffset writes a negative offset with a leading minus, not a doubled sign', () => {
  assert.equal(isoWithOffset(new Date(2026, 5, 15, 9, 5, 3)), '2026-06-15T09:05:03-05:00');
});
