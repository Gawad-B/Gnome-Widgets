// Calendar date math on local-time Date objects, the same model the Shell's calendar uses.
// Pure: unit-tested under Node.

export const GRID_DAYS = 42;

export interface DayRange { begin: Date; end: Date }
export interface DeskEvent { id: string; summary: string; start: Date; end: Date }

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Local-calendar arithmetic, so DST changes never shift the time of day.
export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isSameDay = (a: Date, b: Date): boolean => dayKey(a) === dayKey(b);

// The literal start of the day after `d`'s day, built straight from `d`'s own date fields
// with an explicit 0 for hour/minute/second — never by adding 1 to `d`'s own hour. Some
// timezones (e.g. Africa/Cairo, which springs forward at 00:00) skip a day's midnight, so
// asking for hour 0 on that specific day normalizes forward to 01:00; but that drift must
// not leak into the day *after* the skipped one, which has an ordinary midnight of its own.
// `addDays(d, 1)` would carry `d`'s (possibly already-drifted) hour forward and get that
// wrong, so this only ever reads `d`'s date fields, not its time-of-day.
function nextDayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

// The 6-week range the Shell's top-bar calendar shows for `day`'s month (ui/calendar.js
// _rebuildCalendar). Requesting exactly this range keeps the widget and the top bar from
// fighting over the calendar server's single time range.
export function monthGridRange(day: Date, weekStart: number): DayRange {
  const first = new Date(day.getFullYear(), day.getMonth(), 1);
  const daysToWeekStart = (7 + first.getDay() - weekStart) % 7;
  const padding = daysToWeekStart === 0 ? 7 : 0;
  const begin = addDays(first, -(padding + daysToWeekStart));
  // The Shell computes the end by stepping one day at a time with a mutable iterator
  // (ui/calendar.js `iter.setDate(iter.getDate() + 1)`), not by adding 42 in one shot. If a
  // day inside the range has a skipped local midnight (a DST spring-forward at 00:00), the
  // Shell's iterator lands on 01:00 that day and then *keeps* 01:00 for every day after it,
  // because each further `setDate` step carries the iterator's already-drifted hour forward
  // — even though those later days have perfectly ordinary midnights. A single
  // `addDays(begin, GRID_DAYS)` would only see the final day's own DST rules and miss that
  // carried-over drift, so the widget and the Shell's top bar would end up requesting
  // different end times for the same calendar range. Stepping day by day, the same way the
  // Shell does, reproduces that drift exactly.
  let end = begin;
  for (let i = 0; i < GRID_DAYS; i++)
    end = addDays(end, 1);
  return { begin, end };
}

export function weekdayOrder(weekStart: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

// Compares against the literal start of `e.start`'s and `e.end`'s own days (rather than
// checking wall-clock hour === 0), so an all-day event that the calendar server reports
// starting at a day's *actual* first instant is still recognized even when that instant is
// 01:00 because the day's midnight was skipped by DST.
export function isAllDay(e: DeskEvent): boolean {
  return e.end > e.start && e.start.getTime() === startOfDay(e.start).getTime() && e.end.getTime() === startOfDay(e.end).getTime();
}

function compareUpcoming(a: DeskEvent, b: DeskEvent): number {
  const byDay = startOfDay(a.start).getTime() - startOfDay(b.start).getTime();
  if (byDay !== 0)
    return byDay;
  const allDay = Number(isAllDay(b)) - Number(isAllDay(a));
  if (allDay !== 0)
    return allDay;
  return a.start.getTime() - b.start.getTime() || a.summary.localeCompare(b.summary);
}

// Events that have not ended yet, soonest first (all-day events before timed ones on a day).
export function upcomingEvents(events: readonly DeskEvent[], now: Date, limit: number): DeskEvent[] {
  return events.filter(e => e.end > now).sort(compareUpcoming).slice(0, limit);
}

export function eventsOnDay(events: readonly DeskEvent[], day: Date): DeskEvent[] {
  const begin = startOfDay(day);
  const end = nextDayStart(day);
  return events.filter(e => e.start < end && e.end > begin).sort(compareUpcoming);
}

export function msUntilLocalMidnight(now: Date): number {
  return nextDayStart(now).getTime() - now.getTime();
}
