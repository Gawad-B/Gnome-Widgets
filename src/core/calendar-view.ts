// Which day and month a calendar view shows. Pure: unit-tested under Node.
import { addDays, isSameDay, monthGridRange, startOfDay, type DayRange, type DeskEvent } from './calendar-math.ts';

export interface CalendarView {
  readonly day: Date;    // selected day, at its start
  readonly month: Date;  // first of the month shown
}

export const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);

export const sameMonth = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

export const selectDay = (day: Date): CalendarView => {
  const start = startOfDay(day);
  return { day: start, month: firstOfMonth(start) };
};

export const todayView = (now: Date): CalendarView => selectDay(now);

export const isToday = (view: CalendarView, now: Date): boolean =>
  isSameDay(view.day, now) && sameMonth(view.month, now);

// A view outside the current month needs the service to load that month.
export const needsBrowse = (view: CalendarView, now: Date): boolean => !sameMonth(view.month, now);

// Local-calendar stepping; selectDay() re-normalizes to the day's start, so a DST-drifted hour
// from addDays() never leaks into the next step.
export const stepDay = (view: CalendarView, n: number): CalendarView => selectDay(addDays(view.day, n));

export function stepMonth(view: CalendarView, n: number, now: Date): CalendarView {
  const target = new Date(view.month.getFullYear(), view.month.getMonth() + n, 1);
  if (sameMonth(target, now))
    return todayView(now);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return selectDay(new Date(target.getFullYear(), target.getMonth(), Math.min(view.day.getDate(), lastDay)));
}

// The service's own `browse` snapshot (services/calendar.ts's CalendarBrowse), narrowed to what
// pickCalendarData needs - kept structural rather than importing that type directly, so this
// stays a leaf core module with nothing importing back from services/.
export interface CalendarBrowseSnapshot {
  readonly owner: object;
  readonly month: Date;
  readonly range: DayRange;
  readonly events: readonly DeskEvent[];
}

export type CalendarDataDecision =
  | { kind: 'today' }
  | { kind: 'browse'; range: DayRange; events: readonly DeskEvent[] }
  | { kind: 'pending'; range: DayRange }
  | { kind: 'go-today' };

// Which data a calendar view (a widget, or the popup) should actually render. The service
// publishes at most one active `browse` at a time, so a view sitting outside the
// current month has to work out whether that browse is still *its own*, someone else's, or gone
// - and if it's gone, whether to fall back to today outright or wait, showing an empty grid, for
// a popup that's still open on this same month. Pure; used by the widget
// (widgets/calendar/calendar.ts) only - the popup (shell/calendar-popup.ts) has its own, different
// rule: it re-claims its month when the browse is gone instead of falling back to today. `owner`
// is the caller's own identity, compared by reference against `browse.owner`; `popupOpen` is
// whether the widget's popup is currently open, which keeps a browse usable even after the popup
// took ownership of it (see calendar-popup-controller.ts).
//
// - 'today': the view is on the current month; render the always-current today snapshot.
// - 'browse': a usable browse for this exact month exists; render its own range/events.
// - 'pending': the view needs another month and nothing usable is loaded for it yet, but a popup
//   is open on it (about to load, or waiting on a reclaim) - render an empty grid over that
//   month's own range instead of bouncing back to today out from under the open popup.
// - 'go-today': the view needs another month, nothing usable is loaded for it, and no popup is
//   open to wait for - the caller should reset its view to today instead of rendering it.
export function pickCalendarData(
  view: CalendarView, now: Date, weekStart: number,
  browse: CalendarBrowseSnapshot | null, owner: object, popupOpen: boolean,
): CalendarDataDecision {
  if (!needsBrowse(view, now))
    return { kind: 'today' };
  const usable = browse !== null && sameMonth(browse.month, view.month) && (browse.owner === owner || popupOpen);
  if (usable)
    return { kind: 'browse', range: browse!.range, events: browse!.events };
  if (!popupOpen)
    return { kind: 'go-today' };
  return { kind: 'pending', range: monthGridRange(view.month, weekStart) };
}
