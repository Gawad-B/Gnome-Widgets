// Regression test pinned to a timezone that skips a local midnight by DST, so it exercises the
// same instant Africa/Cairo hits every year: 2026-04-24 springs forward *at* 00:00, so that
// day's midnight never exists as a local time and Date normalizes it forward to 01:00 (see
// test/core/calendar-math-dst.test.ts).
process.env.TZ = 'Africa/Cairo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDay, stepDay } from '../../src/core/calendar-view.ts';

test('Cairo: stepping across the midnight spring-forward day never skips or repeats a day', () => {
  // That day's 00:00 doesn't exist, so new Date(y, m, d) for it is 01:00.
  let v = selectDay(new Date(2026, 3, 22));
  const keys: string[] = [];
  for (let i = 0; i < 5; i++) {
    keys.push(`${v.day.getMonth() + 1}-${v.day.getDate()}`);
    v = stepDay(v, 1);
  }
  assert.deepEqual(keys, ['4-22', '4-23', '4-24', '4-25', '4-26']); // five consecutive dates
});

test('Cairo: stepping across the fall-back day never repeats a day', () => {
  // 2026-10-29/30 has an extra hour (23:00-23:59 occurs twice as the clocks fall back from
  // EEST to EET), so that day is 25 hours long. A naive `start.getTime() + 86_400_000` step
  // from its midnight lands back on the *same* day at 23:00, not on the next day - only
  // field-based stepping (stepDay -> calendar-math's addDays) gets this right.
  let v = selectDay(new Date(2026, 9, 28));
  const keys: string[] = [];
  for (let i = 0; i < 5; i++) {
    keys.push(`${v.day.getMonth() + 1}-${v.day.getDate()}`);
    v = stepDay(v, 1);
  }
  assert.deepEqual(keys, ['10-28', '10-29', '10-30', '10-31', '11-1']); // five consecutive dates
});
