import St from 'gi://St';
import { dayKey, type DayRange, type DeskEvent } from '../../core/calendar-math.ts';
import type { CalendarView } from '../../core/calendar-view.ts';
import { localDate } from './dates.ts';
import { buildDayDetail } from './day-events.ts';
import { buildMonthGrid } from './month-grid.ts';
import { buildNavHeader } from './nav-header.ts';

export interface LargeRenderOptions {
  box: St.BoxLayout;
  view: CalendarView;
  now: Date;
  today: boolean;
  weekStart: number;
  range: DayRange;
  rawEvents: readonly DeskEvent[]; // the dep key below is by reference, not by value
  events: DeskEvent[];             // the filtered list actually rendered
  use24h: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: (() => void) | null;
  onDaySelected: (day: Date) => void;
}

// L's header + month grid + selected-day detail. The header and grid are comparatively expensive
// to rebuild (a 7x6 button grid), so they're mounted once and only remounted when their own
// dependencies actually change - not on every render (a clock tick, e.g., re-renders far more
// often than the grid itself needs to move). The detail section is cheap and time-dependent
// (today's events age off the "upcoming" list as the clock ticks), so it's rebuilt every render
// regardless of whether the grid was.
export class LargeCalendarView {
  private _header: St.BoxLayout | null = null;
  private _grid: St.Widget | null = null;
  private _detail: St.BoxLayout | null = null;
  // Keyed on the *raw* (pre-filter) events array by reference, plus range begin/end, month and
  // day: every render rebuilds a fresh `events` list even when nothing actually changed, so
  // reusing that by reference wouldn't help - `rawEvents` is what stays referentially stable
  // between renders that truly changed nothing.
  private _deps: {
    monthTime: number; dayKey: string; rangeBegin: number; rangeEnd: number;
    rawEvents: readonly DeskEvent[]; todayKey: string;
  } | null = null;

  // Whether the grid is currently mounted - calendar.ts checks this to decide whether `box` still
  // holds it (a size change away from L and back, or the loading/error states, tear it down via
  // reset() below without going through here).
  get mounted(): boolean {
    return this._grid !== null;
  }

  // Forgets the mounted actors; the caller always follows with box.destroy_all_children().
  reset(): void {
    this._header = null;
    this._grid = null;
    this._deps = null;
    this._detail = null;
  }

  render(opts: LargeRenderOptions): void {
    const { box, view: v, now, today, weekStart, range, rawEvents, events, use24h, onPrev, onNext, onToday, onDaySelected } = opts;
    const monthTime = v.month.getTime();
    const dKey = dayKey(v.day);
    const todayKey = dayKey(now);
    const rangeBegin = range.begin.getTime();
    const rangeEnd = range.end.getTime();

    const deps = this._deps;
    const changed = !deps || deps.monthTime !== monthTime || deps.dayKey !== dKey ||
      deps.rangeBegin !== rangeBegin || deps.rangeEnd !== rangeEnd ||
      deps.rawEvents !== rawEvents || deps.todayKey !== todayKey;

    if (changed) {
      this._header?.destroy();
      this._grid?.destroy();
      this._header = buildNavHeader({
        title: localDate(v.month).format('%B %Y') ?? '',
        onPrev, onNext, onToday,
      });
      this._grid = buildMonthGrid({
        month: v.month, range, weekStart, events, now,
        selected: today ? null : v.day,
        onDayClicked: onDaySelected,
        variant: 'widget',
      });
      this._deps = { monthTime, dayKey: dKey, rangeBegin, rangeEnd, rawEvents, todayKey };
      box.insert_child_at_index(this._grid, 0);
      box.insert_child_at_index(this._header, 0);
    }

    this._detail?.destroy();
    this._detail = buildDayDetail({ day: v.day, now, today, events, use24h, limit: 3 });
    box.add_child(this._detail);
  }
}
