// Regression tests pinned to a timezone that skips a local midnight by DST, so they exercise
// the same instant Africa/Cairo hits every year: 2026-04-24 springs forward *at* 00:00, so
// that day's midnight never exists as a local time and Date normalizes it forward to 01:00.
process.env.TZ = 'Africa/Cairo';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventsOnDay, isAllDay, monthGridRange, msUntilLocalMidnight, GRID_DAYS, addDays,
  type DeskEvent,
} from '../../src/core/calendar-math.ts';

// A line-for-line port of the Shell's own range computation (ui/calendar.js
// _rebuildCalendar), including its habit of stepping the end date one day at a time with a
// mutable iterator. `monthGridRange` must match this exactly, drift and all, or the widget
// and the Shell's top-bar calendar end up requesting different ranges from the same
// calendar server.
function shellRange(selected: Date, weekStart: number): { begin: Date; end: Date } {
  const beginDate = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const daysToWeekStart = (7 + beginDate.getDay() - weekStart) % 7;
  const weekPadding = daysToWeekStart === 0 ? 7 : 0;
  beginDate.setDate(beginDate.getDate() - (weekPadding + daysToWeekStart));
  const iter = new Date(beginDate);
  let row = 2;
  while (row < 8) {
    iter.setDate(iter.getDate() + 1);
    if (iter.getDay() === weekStart)
      row++;
  }
  return { begin: beginDate, end: iter };
}

test('monthGridRange matches the Shell reference loop for every month 2024-2030 and every week start', () => {
  for (let year = 2024; year <= 2030; year++) {
    for (let month = 0; month < 12; month++) {
      for (let weekStart = 0; weekStart < 7; weekStart++) {
        const day = new Date(year, month, 15);
        const ours = monthGridRange(day, weekStart);
        const shells = shellRange(day, weekStart);
        assert.equal(ours.begin.getTime(), shells.begin.getTime(), `begin mismatch ${year}-${month + 1} ws${weekStart}`);
        assert.equal(ours.end.getTime(), shells.end.getTime(), `end mismatch ${year}-${month + 1} ws${weekStart}`);
      }
    }
  }
});

test('monthGridRange end carries the Shell-style 01:00 drift past the Apr 24 2026 skipped midnight', () => {
  const range = monthGridRange(new Date(2026, 3, 10), 6);
  assert.deepEqual(range.end, new Date(2026, 4, 9, 1));
});

test('GRID_DAYS still produces a 42-day range end to end (sanity check alongside the drift)', () => {
  const range = monthGridRange(new Date(2026, 3, 10), 6);
  let end = range.begin;
  for (let i = 0; i < GRID_DAYS; i++)
    end = addDays(end, 1);
  assert.deepEqual(range.end, end);
});

test('msUntilLocalMidnight counts 9 hours from 15:00 on the day the midnight ahead is skipped', () => {
  assert.equal(msUntilLocalMidnight(new Date(2026, 3, 24, 15)), 9 * 3_600_000);
});

test('eventsOnDay for Apr 24 does not pick up an event that starts at Apr 25 00:30', () => {
  const ev: DeskEvent = { id: 'x', summary: 'x', start: new Date(2026, 3, 25, 0, 30), end: new Date(2026, 3, 25, 0, 45) };
  assert.deepEqual(eventsOnDay([ev], new Date(2026, 3, 24)), []);
});

test('an all-day event starting at Apr 24\'s actual start of day (01:00, since midnight was skipped) counts as all-day', () => {
  const ev: DeskEvent = { id: 'a', summary: 'a', start: new Date(2026, 3, 24), end: new Date(2026, 3, 25) };
  assert.equal(ev.start.getHours(), 1, 'sanity: Apr 24 00:00 normalizes to 01:00 in this timezone');
  assert.equal(isAllDay(ev), true);
});
