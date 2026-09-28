import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayKey, eventsOnDay, isAllDay, isSameDay, monthGridRange, msUntilLocalMidnight,
  startOfDay, upcomingEvents, weekdayOrder, type DeskEvent,
} from '../../src/core/calendar-math.ts';

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const ev = (id: string, start: Date, end: Date, summary = id): DeskEvent => ({ id, summary, start, end });

test('startOfDay, addDays and dayKey work in local time', () => {
  assert.deepEqual(startOfDay(d(2026, 9, 26, 17, 30)), d(2026, 9, 26));
  assert.deepEqual(addDays(d(2026, 9, 30), 1), d(2026, 10, 1));
  assert.equal(dayKey(d(2026, 1, 5)), '2026-01-05');
  assert.equal(isSameDay(d(2026, 9, 26, 1), d(2026, 9, 26, 23)), true);
  assert.equal(isSameDay(d(2026, 9, 26), d(2026, 9, 27)), false);
});

test('monthGridRange matches the Shell top-bar calendar (6 weeks)', () => {
  // Sep 1 2026 is a Tuesday.
  assert.deepEqual(monthGridRange(d(2026, 9, 26), 0), { begin: d(2026, 8, 30), end: d(2026, 10, 11) });
  assert.deepEqual(monthGridRange(d(2026, 9, 26), 1), { begin: d(2026, 8, 31), end: d(2026, 10, 12) });
  // Feb 1 2026 is a Sunday: a month starting on the week start gets a full padding week before it.
  assert.deepEqual(monthGridRange(d(2026, 2, 10), 0), { begin: d(2026, 1, 25), end: d(2026, 3, 8) });
});

test('weekdayOrder rotates from the week start', () => {
  assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(weekdayOrder(6), [6, 0, 1, 2, 3, 4, 5]);
});

test('isAllDay: midnight-to-midnight spans only', () => {
  assert.equal(isAllDay(ev('a', d(2026, 9, 26), d(2026, 9, 27))), true);
  assert.equal(isAllDay(ev('b', d(2026, 9, 26), d(2026, 9, 29))), true);
  assert.equal(isAllDay(ev('c', d(2026, 9, 26, 9), d(2026, 9, 26, 10))), false);
  assert.equal(isAllDay(ev('d', d(2026, 9, 26), d(2026, 9, 26))), false);
});

test('upcomingEvents drops finished events, sorts by day, all-day first, then start time', () => {
  const now = d(2026, 9, 26, 12);
  const list = [
    ev('late', d(2026, 9, 26, 18), d(2026, 9, 26, 19)),
    ev('past', d(2026, 9, 26, 8), d(2026, 9, 26, 9)),
    ev('ongoing', d(2026, 9, 26, 11), d(2026, 9, 26, 13)),
    ev('allday', d(2026, 9, 26), d(2026, 9, 27)),
    ev('tomorrow', d(2026, 9, 27, 9), d(2026, 9, 27, 10)),
  ];
  assert.deepEqual(upcomingEvents(list, now, 10).map(e => e.id), ['allday', 'ongoing', 'late', 'tomorrow']);
  assert.deepEqual(upcomingEvents(list, now, 2).map(e => e.id), ['allday', 'ongoing']);
});

test('eventsOnDay returns overlapping events in upcoming order', () => {
  const list = [
    ev('multi', d(2026, 9, 25), d(2026, 9, 28)),
    ev('other', d(2026, 9, 27, 9), d(2026, 9, 27, 10)),
    ev('today', d(2026, 9, 26, 9), d(2026, 9, 26, 10)),
  ];
  assert.deepEqual(eventsOnDay(list, d(2026, 9, 26)).map(e => e.id), ['multi', 'today']);
});

test('msUntilLocalMidnight counts to the next local midnight', () => {
  assert.equal(msUntilLocalMidnight(d(2026, 9, 26, 23)), 3_600_000);
  assert.equal(msUntilLocalMidnight(d(2026, 9, 26)), 86_400_000);
});
