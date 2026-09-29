// Asia/Kolkata is a fixed UTC+05:30 all year (India has observed no DST since 1945), so this
// exercises a non-zero minutes component in the offset, which a hours-only implementation
// would get wrong.
process.env.TZ = 'Asia/Kolkata';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWithOffset } from '../../src/core/tasks.ts';

test('isoWithOffset writes a half-hour offset', () => {
  assert.equal(isoWithOffset(new Date(2026, 5, 15, 18, 0, 0)), '2026-06-15T18:00:00+05:30');
});
