import GDesktopEnums from 'gi://GDesktopEnums';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import { CalendarBrowseState } from '../core/calendar-browse.ts';
import { dayKey, monthGridRange, msUntilLocalMidnight, type DayRange, type DeskEvent } from '../core/calendar-math.ts';
import { firstOfMonth, sameMonth } from '../core/calendar-view.ts';
import { dateMenuPopup, resetShellCalendarToToday, setShellCalendarDate, shellEventSource, type ShellDateMenuPopup, type ShellEventSource } from '../shell/shell-private.ts';
import { Service, type Scheduler } from './service.ts';

// One caller's request to look at another month: the month itself, the six-week grid
// range read the same way the current month's is, and the events in it.
export interface CalendarBrowse {
  owner: object;
  month: Date;       // first of the browsed month
  range: DayRange;   // monthGridRange(month, weekStart)
  events: DeskEvent[];
}

export interface CalendarValue {
  today: Date;
  weekStart: number;
  range: DayRange;
  events: DeskEvent[];
  hasCalendars: boolean;
  // Set while some view browses another month. today/range/events then hold the cached
  // today snapshot (the shared source only has the browsed month loaded).
  browse: CalendarBrowse | null;
}

// Never wait longer than this between local-midnight checks: GLib timeouts run on the
// monotonic clock, which pauses across suspend, so a single long wait armed for "tonight's
// midnight" can fire well after the machine wakes up the next day.
const DAY_CHECK_MS = 60_000;

// Bounded fallback for the today-cache hold (core/calendar-browse.ts's CalendarBrowseState): a
// user with no calendars, or calendars with no events today, never gets an
// EventsAddedOrUpdated/removal signal to clear the hold on its own (ui/calendar.js
// DBusEventSource only emits 'changed' again for an add, a remove, or the calendar server's
// D-Bus name appearing/vanishing - never for "still nothing here"). Without this, the hold would
// then survive indefinitely.
const HOLD_TIMEOUT_MS = 2_000;

// Snapshots and Shell API calls each get their own Date instances: a Date is mutable, and
// nothing here can guarantee the Shell (or a widget holding an old snapshot) never mutates one
// in place.
const copyDate = (d: Date): Date => new Date(d.getTime());

const sameRange = (a: DayRange, b: DayRange): boolean =>
  a.begin.getTime() === b.begin.getTime() && a.end.getTime() === b.end.getTime();

// Events for the current month grid, read from the top-bar calendar's shared event source.
// Re-requests the range whenever the top-bar menu closes (the user may have browsed another
// month there) and polls for a local-midnight rollover at least once a minute.
//
// Browsing: the shared source holds exactly one requested range, so only one month can be loaded at a time. A single
// `browse()` owner may point the Shell's own top-bar calendar at another month; while that's
// active, `today`/`range`/`events` keep serving a cached snapshot of today (read the last time
// the service wasn't browsing) and the browsed month's own data comes back as `browse`. Who owns
// browsing, and the hold that snapshot needs across a browse ending, is
// core/calendar-browse.ts's CalendarBrowseState (gi-free, unit-tested); this class keeps only the
// Shell I/O - the event source, settings, the dateMenu hooks, and the setShellCalendarDate/
// resetShellCalendarToToday calls that source drives.
export class CalendarService extends Service<CalendarValue> {
  private readonly _ticks: Scheduler;
  private readonly _browseState: CalendarBrowseState;
  private _source: ShellEventSource | null = null;
  private _settings: Gio.Settings | null = null;
  private _menuPopup: ShellDateMenuPopup | null = null;
  private _range: DayRange | null = null;
  private _weekStart = 0;
  private _lastDay: string | null = null;
  private _tick: number | null = null;
  private _todayCache: { range: DayRange; events: DeskEvent[] } | null = null;

  constructor(scheduler: Scheduler) {
    super(scheduler);
    this._ticks = scheduler;
    this._browseState = new CalendarBrowseState(scheduler, HOLD_TIMEOUT_MS, () => this._emit());
  }

  protected start(): void {
    const source = shellEventSource();
    if (!source) {
      this.fail(new Error('the Shell calendar is unavailable'));
      return;
    }
    this._source = source;
    this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.calendar' });
    this._settings.connectObject('changed::week-start-day', () => {
      const target = this._browseState.target;
      if (target) {
        // A full _refresh() would reset the Shell calendar to today and request today's range,
        // undoing the browse (only one range can be loaded at a time). The new week
        // start still needs to reach both grids: the browsed one gets it from _emit() below
        // (monthGridRange(target.month, this._weekStart)), and today's own alignment - used once
        // browsing ends - needs the same recompute here, or a today-view L grid would get a new
        // weekday header over cells still laid out with the old week start. No
        // setShellCalendarDate() call here: the Shell's own top-bar calendar reacts to this same
        // setting directly and rebuilds its (still browsed) selection itself, so re-pointing it
        // at a month it's already showing would be a no-op.
        this._weekStart = this._weekStartDay();
        this._range = monthGridRange(new Date(), this._weekStart);
        this._rebaseTodayCache();
        this._emit();
      } else {
        this._refresh();
      }
    }, this);
    source.connectObject('changed', () => this._emit(), 'notify::has-calendars', () => this._emit(), this);
    this._menuPopup = dateMenuPopup();
    this._menuPopup?.connectObject('open-state-changed', (_menu: unknown, open: boolean) => {
      if (open)
        return;
      const target = this._browseState.target;
      if (target) {
        // The date menu reset itself to today on open (dateMenu.js); point it back at the
        // browsed month now that the user is done looking at the top bar.
        setShellCalendarDate(target.month);
        this._emit();
      } else {
        this._refresh();
      }
    }, this);
    this._refresh();
  }

  protected stop(): void {
    if (this._tick !== null) {
      this._ticks.cancel(this._tick);
      this._tick = null;
    }
    // Leave the Shell's own top-bar calendar on today, not mid-browse, for whatever opens the
    // menu next (this extension disabling, or just stopping - the last subscriber leaving).
    if (this._browseState.target)
      resetShellCalendarToToday();
    this._source?.disconnectObject(this);
    this._settings?.disconnectObject(this);
    this._menuPopup?.disconnectObject(this);
    this._source = null;
    this._settings = null;
    this._menuPopup = null;
    this._range = null;
    this._lastDay = null;
    this._todayCache = null;
    this._browseState.clear();
  }

  // One browsing view at a time: a new owner's browse replaces the previous owner's.
  // `null`, or the current month, ends `owner`'s browse; ending someone else's is a no-op. The
  // arbitration itself lives in CalendarBrowseState.request(); this only translates its result
  // into Shell I/O.
  browse(owner: object, month: Date | null): void {
    if (!this._source)
      return;
    const ends = month === null || sameMonth(month, new Date());
    const result = this._browseState.request(owner, ends ? null : firstOfMonth(month!), ends);
    switch (result.kind) {
    case 'none':
      return;
    case 'end':
      // _refresh() below reloads today's range on the shared source, which synchronously clears
      // its events before the real data comes back - CalendarBrowseState already armed the hold
      // that keeps _emit() serving the last good snapshot across that gap (see its own comment).
      this._refresh();
      return;
    case 'start':
      setShellCalendarDate(result.month);
      this._emit();
      return;
    }
  }

  private _weekStartDay(): number {
    const value = this._settings?.get_enum('week-start-day') ?? GDesktopEnums.Weekday.DEFAULT;
    return value === GDesktopEnums.Weekday.DEFAULT ? Shell.util_get_week_start() : value % 7;
  }

  private _refresh(): void {
    if (!this._source)
      return;
    this._weekStart = this._weekStartDay();
    // Computed before resetShellCalendarToToday(): that call, or a browse reclaim it triggers
    // re-entrantly through a synchronous 'changed' (see the comment below), can itself call back
    // into _emit() before this function returns. _range must already describe the new day's grid
    // by then, or a reclaimed browse's _emit() would rebase _todayCache against the *old* range
    // (see the browsing branch of _emit() for the other half of this fix).
    this._range = monthGridRange(new Date(), this._weekStart);
    // Put the top bar's calendar back on today so its reaction to the 'changed' signal our own
    // requestRange() below triggers re-requests *our* month instead of re-asserting whatever
    // month it was last showing. See resetShellCalendarToToday()'s own comment for why. Ours
    // becomes a same-range no-op right after (requestRange ignores a range identical to the last
    // one), which is exactly the point. Either call can itself synchronously clear the source's
    // events and re-emit 'changed' before the real reload lands; _emit() tells that echo apart
    // from the real thing by whether its read comes back empty (see its own comment), not by
    // anything tracked here.
    resetShellCalendarToToday();
    this._source.requestRange(copyDate(this._range.begin), copyDate(this._range.end));
    this._lastDay = dayKey(new Date());
    this._emit();
    if (!this.running)
      return;
    this._armDayCheck();
  }

  // Re-arms a check at most DAY_CHECK_MS out (never a single long wait for local midnight — see
  // DAY_CHECK_MS). Cancels any check already pending first, and only re-arms while running.
  private _armDayCheck(): void {
    if (this._tick !== null)
      this._ticks.cancel(this._tick);
    if (!this.running)
      return;
    const delay = Math.min(msUntilLocalMidnight(new Date()) + 1000, DAY_CHECK_MS);
    this._tick = this._ticks.schedule(delay, () => {
      this._tick = null;
      if (dayKey(new Date()) !== this._lastDay) {
        // The day actually rolled over: midnight ends every browse - holding the last
        // snapshot exactly like an owner-initiated browse(owner, null) does - then a full refresh
        // re-requests the range and re-arms.
        this._browseState.endForMidnight();
        this._refresh();
        return;
      }
      this._armDayCheck();
    });
  }

  // Rebases a still-live _todayCache onto the current _range when they've drifted apart, keeping
  // its cached events untouched - the same fix-up the week-start handler above applies, and the
  // one the browsing branch of _emit() needs for the same reason (see its own comment).
  private _rebaseTodayCache(): void {
    if (this._range && this._todayCache && !sameRange(this._todayCache.range, this._range)) {
      this._todayCache = {
        range: { begin: copyDate(this._range.begin), end: copyDate(this._range.end) },
        events: this._todayCache.events,
      };
    }
  }

  private _emit(): void {
    if (!this._source || !this._range)
      return;
    const source = this._source;
    const read = (range: DayRange): DeskEvent[] =>
      source.getEvents(copyDate(range.begin), copyDate(range.end))
        .map(e => ({ id: e.id, summary: e.summary, start: copyDate(e.date), end: copyDate(e.end) }));

    let browse: CalendarBrowse | null = null;
    const target = this._browseState.target;
    if (target) {
      const range = monthGridRange(target.month, this._weekStart);
      browse = { owner: target.owner, month: copyDate(target.month), range, events: read(range) };
      // A browse reclaim (calendar-popup.ts's _render()) can run re-entrantly, from inside this
      // very _refresh() → resetShellCalendarToToday() → synchronous 'changed' chain, before
      // _refresh() gets back around to updating _todayCache itself (the else branch below, which
      // this browsing branch skips). Left alone, _todayCache.range would keep describing the grid
      // from before the day (and possibly month) rolled over, even though _range - and the real
      // request the Shell will end up loading - has already moved on.
      this._rebaseTodayCache();
    } else {
      const events = read(this._range);
      const same = this._todayCache !== null && sameRange(this._todayCache.range, this._range);
      // CalendarBrowseState.admitRead folds together the hold's same-range gate and its
      // clear-on-non-empty rule (see its own comment) - a different range, or a non-empty read,
      // replaces the cache regardless of the hold; a still-empty read on the same range doesn't.
      if (this._browseState.admitRead(same, events.length > 0)) {
        this._todayCache = {
          range: { begin: copyDate(this._range.begin), end: copyDate(this._range.end) },
          events,
        };
      }
    }
    const today = this._todayCache ?? { range: this._range, events: [] };
    this.publish({
      today: new Date(),
      weekStart: this._weekStart,
      range: { begin: copyDate(today.range.begin), end: copyDate(today.range.end) },
      events: today.events,
      hasCalendars: source.hasCalendars,
      browse,
    });
  }
}
