import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthGridRange, type DayRange } from '../../src/core/calendar-math.ts';
import {
  firstOfMonth, isToday, needsBrowse, pickCalendarData, sameMonth, selectDay, stepDay, stepMonth,
  todayView, type CalendarBrowseSnapshot,
} from '../../src/core/calendar-view.ts';

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const NOW = d(2026, 9, 28, 14, 5);

test('todayView selects today in its month; isToday', () => {
  const v = todayView(NOW);
  assert.deepEqual(v, { day: d(2026, 9, 28), month: d(2026, 9, 1) });
  assert.equal(isToday(v, NOW), true);
  assert.equal(isToday(stepDay(v, 1), NOW), false);
  assert.equal(needsBrowse(v, NOW), false);
});

test('stepDay crosses month and year boundaries and moves the month with it', () => {
  assert.deepEqual(stepDay(todayView(d(2026, 9, 30)), 1), { day: d(2026, 10, 1), month: d(2026, 10, 1) });
  assert.deepEqual(stepDay(todayView(d(2027, 1, 1)), -1), { day: d(2026, 12, 31), month: d(2026, 12, 1) });
  assert.equal(needsBrowse(stepDay(todayView(d(2026, 9, 30)), 1), d(2026, 9, 30)), true);
});

test('stepMonth keeps the day-of-month, clamped; entering the current month selects today', () => {
  assert.deepEqual(stepMonth(selectDay(d(2027, 1, 31)), 1, NOW), { day: d(2027, 2, 28), month: d(2027, 2, 1) });
  assert.deepEqual(stepMonth(selectDay(d(2028, 1, 31)), 1, NOW), { day: d(2028, 2, 29), month: d(2028, 2, 1) });
  assert.deepEqual(stepMonth(todayView(NOW), 1, NOW), { day: d(2026, 10, 28), month: d(2026, 10, 1) });
  assert.deepEqual(stepMonth(stepMonth(todayView(NOW), 1, NOW), -1, NOW), todayView(NOW));
  assert.deepEqual(stepMonth(selectDay(d(2026, 12, 15)), 1, NOW), { day: d(2027, 1, 15), month: d(2027, 1, 1) });
});

test('selectDay on a padding day moves to that day\'s month', () => {
  assert.deepEqual(selectDay(d(2026, 10, 2, 9)), { day: d(2026, 10, 2), month: d(2026, 10, 1) });
});

test('firstOfMonth and sameMonth', () => {
  assert.deepEqual(firstOfMonth(d(2026, 9, 28, 23)), d(2026, 9, 1));
  assert.equal(sameMonth(d(2026, 9, 1), d(2026, 9, 30, 23)), true);
  assert.equal(sameMonth(d(2026, 9, 1), d(2025, 9, 1)), false);
});

// --- pickCalendarData ---------------------------------------------------------------------

const WEEK_START = 1;
const fakeRange = (): DayRange => monthGridRange(d(2026, 11, 1), WEEK_START);
const snapshot = (owner: object, month: Date): CalendarBrowseSnapshot =>
  ({ owner, month, range: fakeRange(), events: [] });

test('pickCalendarData: today when the view is on the current month', () => {
  const v = todayView(NOW);
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, null, {}, false), { kind: 'today' });
});

test('pickCalendarData: go-today when nothing is loaded for another month and no popup is waiting', () => {
  const v = selectDay(d(2026, 11, 5));
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, null, {}, false), { kind: 'go-today' });
});

test('pickCalendarData: pending (empty, own month range) when a popup is open on an unloaded month', () => {
  const v = selectDay(d(2026, 11, 5));
  const result = pickCalendarData(v, NOW, WEEK_START, null, {}, true);
  assert.equal(result.kind, 'pending');
  if (result.kind === 'pending')
    assert.deepEqual(result.range, monthGridRange(v.month, WEEK_START));
});

test('pickCalendarData: a matching browse for the same owner and month is used directly', () => {
  const owner = {};
  const v = selectDay(d(2026, 11, 5));
  const browse = snapshot(owner, v.month);
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, browse, owner, false),
    { kind: 'browse', range: browse.range, events: browse.events });
});

test('pickCalendarData: a different owner\'s browse for the same month is still usable while our own popup is open', () => {
  const owner = {};
  const otherOwner = {};
  const v = selectDay(d(2026, 11, 5));
  const browse = snapshot(otherOwner, v.month);
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, browse, owner, true),
    { kind: 'browse', range: browse.range, events: browse.events });
});

test('pickCalendarData: someone else\'s browse for the same month is not usable with our popup closed', () => {
  const owner = {};
  const otherOwner = {};
  const v = selectDay(d(2026, 11, 5));
  const browse = snapshot(otherOwner, v.month);
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, browse, owner, false), { kind: 'go-today' });
});

test('pickCalendarData: a browse for a different month is never usable, regardless of owner', () => {
  const owner = {};
  const v = selectDay(d(2026, 11, 5));
  const browse = snapshot(owner, d(2026, 9, 1)); // owner matches, but the wrong month
  assert.deepEqual(pickCalendarData(v, NOW, WEEK_START, browse, owner, false), { kind: 'go-today' });
  const withPopup = pickCalendarData(v, NOW, WEEK_START, browse, owner, true);
  assert.equal(withPopup.kind, 'pending');
});
