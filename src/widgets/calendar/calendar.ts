import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { dayKey, type DayRange, type DeskEvent } from '../../core/calendar-math.ts';
import {
  isToday, needsBrowse, pickCalendarData, selectDay, stepDay, stepMonth, todayView, type CalendarView,
} from '../../core/calendar-view.ts';
import type { CalendarService, CalendarValue } from '../../services/calendar.ts';
import type { Snapshot } from '../../services/service.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { LargeCalendarView } from './calendar-large.ts';
import { CalendarPopupController } from './calendar-popup-controller.ts';
import { IdleReturn, ScrollStepper } from './calendar-input.ts';
import { renderM, renderS } from './calendar-sizes.ts';
import { filterEvents, renderEmptyMessage } from './day-events.ts';

// A view returns to today on its own after this long without interaction.
const IDLE_RETURN_MS = 120_000;

// A stable empty-array reference for the "browsing, but not our own" render path, so
// LargeCalendarView's reuse check never sees a "changed" events reference just because two `[]`
// literals aren't `===`.
const EMPTY: readonly DeskEvent[] = [];

// S/M/L render from the widget's own CalendarView (selected day + month shown - see
// calendar-sizes.ts for S/M, calendar-large.ts for L's month grid). Every size shares one
// empty-state line for the states the service itself can be in: "…"/"Calendar unavailable"/"No
// calendars" - those states render no nav and ignore scroll (see `_ready()`).
//
// Browsing: the view asks the service to browse whenever it leaves the current month. A primary click on empty space opens
// the larger popup (shell/calendar-popup.ts); calendar-popup-controller.ts owns its gesture and
// lifetime, and `_popupCtl.isOpen` (below) is how _render() tells the popup apart from any other
// browse takeover.
class CalendarWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private readonly _birthdays: boolean;
  private readonly _service: CalendarService;
  private readonly _idle: IdleReturn;
  private readonly _scroll = new ScrollStepper();
  private _snapshot: Snapshot<CalendarValue> | null = null;
  private _use24h = true;
  private _now = new Date();
  private _view: CalendarView;
  private _lastDayKey: string | null = null;
  private _readyState = false;
  private readonly _popupCtl: CalendarPopupController;
  private readonly _large = new LargeCalendarView();

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-cal desk-cal-${ctx.size}`,
      reactive: true,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;
    this._birthdays = ctx.config.birthdays !== false;
    this._service = ctx.hub.calendar();
    this._view = todayView(new Date());
    // While the popup is open, an idle firing must not return to today out from under it - poking
    // instead just restarts the countdown, re-arming harmlessly for as long as the popup stays
    // open (it may sit there browsing the same month for the full 2 minutes).
    this._idle = new IdleReturn(IDLE_RETURN_MS, () => {
      if (this._popupCtl.isOpen)
        this._idle.poke();
      else
        this._goToday();
    });

    // Built before either watch() below: the calendar service can publish synchronously on this
    // very subscribe() call (a shared source that's already running), which would render
    // immediately and reach _popupCtl.isOpen before the constructor got back around to it.
    // Click-to-open-popup: `onClosed` re-asserts this widget's own browse.
    this._popupCtl = new CalendarPopupController({
      box: this._box,
      service: this._service,
      birthdays: this._birthdays,
      ready: () => this._ready(),
      view: () => this._view,
      use24h: () => this._use24h,
      onClosed: () => {
        const browsing = needsBrowse(this._view, this._now);
        this._service.browse(this, browsing ? this._view.month : null);
        // A fresh full idle window from the moment the popup closes, still browsing.
        if (browsing)
          this._idle.poke();
        this._render();
      },
    });
    // Before the browse-ending cleanup below, so the popup's own browse ends first.
    ctx.scope.onCleanup(() => this._popupCtl.destroy());

    ctx.scope.watch(this._service, snapshot => {
      this._snapshot = snapshot;
      this._render();
    });
    // Re-renders every clock tick (12h/24h changes, "next event" aging) and returns a browsing
    // view to today on a local-day rollover; otherwise stays put till idle or Today.
    ctx.scope.watch(ctx.hub.clock(), ({ value }) => {
      if (value) {
        this._use24h = value.use24h;
        this._now = new Date(value.now.to_unix() * 1000);
      }
      const today = dayKey(this._now);
      const rolledOver = this._lastDayKey !== null && today !== this._lastDayKey;
      this._lastDayKey = today;
      if (rolledOver)
        this._goToday();
      else
        this._render();
    });

    this._box.connectObject('scroll-event', (_actor: Clutter.Actor, event: Clutter.Event) => this._onScroll(event), this);
    ctx.scope.onCleanup(() => this._box.disconnectObject(this));

    // Ends this widget's own browse (a no-op if it isn't the current owner) and stops its idle timer.
    ctx.scope.onCleanup(() => {
      this._idle.cancel();
      this._service.browse(this, null);
    });
  }

  private _onScroll(event: Clutter.Event): boolean {
    const n = this._scroll.step(event);
    if (n !== 0 && this._ready())
      this._setView(this._size === 'L' ? stepMonth(this._view, n, this._now) : stepDay(this._view, n), true);
    return Clutter.EVENT_STOP;
  }

  private _ready(): boolean {
    return this._readyState;
  }

  private _setView(view: CalendarView, interactive: boolean): void {
    this._view = view;
    if (interactive)
      this._idle.poke();
    else
      this._idle.cancel();
    this._service.browse(this, needsBrowse(view, this._now) ? view.month : null);
    this._render();
  }

  private _goToday(): void {
    this._setView(todayView(this._now), false);
  }

  private _render(): void {
    const snapshot = this._snapshot;
    if (!snapshot || snapshot.state !== 'ready' || !snapshot.value) {
      this._readyState = false;
      this._large.reset();
      this._box.destroy_all_children();
      // 'loading' (and the unused 'empty' state): a subtle placeholder, matching Weather's.
      renderEmptyMessage(this._box, snapshot?.state === 'error' ? 'Calendar unavailable' : '…');
      return;
    }
    const value = snapshot.value;
    if (!value.hasCalendars) {
      this._readyState = false;
      this._large.reset();
      this._box.destroy_all_children();
      renderEmptyMessage(this._box, 'No calendars');
      return;
    }

    const v = this._view;
    // Which data this view actually shows - own browse, popup-open same-month, a take-over
    // (→ today) or nothing loaded yet (→ pending, empty) - is core/calendar-view.ts's
    // pickCalendarData, pure and unit-tested; this only carries out its decision.
    const decision = pickCalendarData(v, this._now, value.weekStart, value.browse, this, this._popupCtl.isOpen);
    if (decision.kind === 'go-today') {
      this._goToday();
      return;
    }
    const range = decision.kind === 'today' ? value.range : decision.range;
    const rawEvents: readonly DeskEvent[] =
      decision.kind === 'today' ? value.events : decision.kind === 'browse' ? decision.events : EMPTY;
    const events = filterEvents(rawEvents, this._birthdays);
    this._readyState = true;

    if (this._size === 'S') {
      this._large.reset();
      this._box.destroy_all_children();
      this._renderS(events);
    } else if (this._size === 'M') {
      this._large.reset();
      this._box.destroy_all_children();
      this._renderM(events);
    } else {
      // No mounted grid means _box still holds stale content (a message line, or S/M after a
      // size change): clear it first, or it would stay wedged in.
      if (!this._large.mounted)
        this._box.destroy_all_children();
      this._renderL(value, range, rawEvents, events);
    }
  }

  private _renderS(events: DeskEvent[]): void {
    const v = this._view;
    const today = isToday(v, this._now);
    renderS({
      box: this._box, day: v.day, now: this._now, events, today,
      onToday: today ? null : () => this._goToday(),
    });
  }

  private _renderM(events: DeskEvent[]): void {
    const v = this._view;
    const today = isToday(v, this._now);
    renderM({
      box: this._box, day: v.day, now: this._now, events, use24h: this._use24h, today,
      onPrev: () => this._setView(stepDay(v, -1), true),
      onNext: () => this._setView(stepDay(v, 1), true),
      onToday: today ? null : () => this._goToday(),
    });
  }

  private _renderL(value: CalendarValue, range: DayRange, rawEvents: readonly DeskEvent[], events: DeskEvent[]): void {
    const v = this._view;
    const now = this._now;
    const today = isToday(v, now);
    this._large.render({
      box: this._box, view: v, now, today, weekStart: value.weekStart, range, rawEvents, events,
      use24h: this._use24h,
      onPrev: () => this._setView(stepMonth(v, -1, now), true),
      onNext: () => this._setView(stepMonth(v, 1, now), true),
      onToday: today ? null : () => this._goToday(),
      onDaySelected: day => this._setView(selectDay(day), true),
    });
  }
}

export const calendarWidget: WidgetDefinition = {
  type: 'calendar',
  name: 'Calendar',
  description: 'Upcoming events and the month',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: { birthdays: true },
  options: [{ kind: 'toggle', key: 'birthdays', label: 'Show birthdays' }],
  create: ctx => new CalendarWidget(ctx),
};
