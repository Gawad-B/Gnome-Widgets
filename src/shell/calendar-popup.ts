import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
  isToday, needsBrowse, sameMonth, selectDay, stepMonth, todayView, type CalendarView,
} from '../core/calendar-view.ts';
import type { CalendarService, CalendarValue } from '../services/calendar.ts';
import type { Snapshot } from '../services/service.ts';
import { localDate } from '../widgets/calendar/dates.ts';
import { buildDayEvents, filterEvents } from '../widgets/calendar/day-events.ts';
import { buildMonthGrid } from '../widgets/calendar/month-grid.ts';
import { buildNavHeader } from '../widgets/calendar/nav-header.ts';
import { dateMenuPopup } from './shell-private.ts';

const CALENDAR_APP_ID = 'org.gnome.Calendar.desktop';

// The larger calendar opened by clicking a Calendar widget: its own month
// browsing, the selected day's events, and a shortcut to GNOME Calendar. Browses as its own
// owner - starting a browse here takes it over from the widget, which re-asserts its
// own browse (if it has one) once this closes (calendar-popup-controller.ts's onClosed).
//
// Follows the same PopupMenu/PopupMenuManager/BoxPointer pattern as the widget context menu
// (shell/context-menu.ts's WidgetMenus), anchored to the widget's own content actor instead of
// the dummy cursor, so it opens right next to the card. Esc and an outside click close it for
// free, through PopupMenuManager - the same mechanism context-menu.ts's menus already rely on.
// The top-bar date menu opening does *not* close it for free (PopupMenuManager only coordinates
// menus it manages, and the date menu has its own, separate one) - open() hooks dateMenuPopup()
// itself for that.
export class CalendarPopup {
  private readonly _menu: PopupMenu.PopupMenu;
  private readonly _manager: PopupMenu.PopupMenuManager;
  private readonly _content: St.BoxLayout;
  private readonly _service: CalendarService;
  private readonly _birthdays: boolean;
  private readonly _onClosed: () => void;
  private _view: CalendarView = todayView(new Date());
  private _snapshot: Snapshot<CalendarValue> | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _use24h = true;
  // True only for the duration of a browse() call _setView() itself made, so the subscribe
  // callback below skips the render a synchronous emit from that call would otherwise cause -
  // _setView()'s own trailing _render() is the one that actually runs (see its own comment).
  private _applyingView = false;

  constructor(source: St.Widget, service: CalendarService, opts: { birthdays: boolean; onClosed: () => void }) {
    this._service = service;
    this._birthdays = opts.birthdays;
    this._onClosed = opts.onClosed;
    this._menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
    this._menu.actor.add_style_class_name('desk-cal-popup');
    Main.layoutManager.uiGroup.add_child(this._menu.actor);
    this._menu.actor.hide();
    this._manager = new PopupMenu.PopupMenuManager(source);
    this._manager.addMenu(this._menu);
    // reactive: false would make St add the `:insensitive` style pseudo-class, and
    // `.popup-inactive-menu-item:insensitive` is a *dim* grey (confirmed against the Shell's own
    // dark.css/light.css). reactive: true avoids that, and activate: false (not reactive: false)
    // is what actually keeps the item non-interactive
    // (`_activatable = reactive && activate`), so it still gets the plain, undimmed
    // `.popup-inactive-menu-item` colour (#fff dark / #222226 light). track_hover is reset after
    // construction (PopupBaseMenuItem's _init passes `track_hover: reactive`, i.e. true),
    // so hovering anywhere in the popup doesn't sweep the whole content area with the Shell's
    // normal menu-item hover highlight - our own inner buttons (arrows, day cells, Today, Open
    // Calendar) keep their own independent hover regardless.
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: true, activate: false, hover: false, can_focus: false });
    item.track_hover = false;
    this._content = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-cal-popup-content', x_expand: true,
    });
    item.add_child(this._content);
    this._menu.addMenuItem(item);
    this._menu.connectObject('open-state-changed', (_m: unknown, open: boolean) => {
      if (!open)
        this._onMenuClosed();
    }, this);
  }

  // Opens on `view` (the widget's current month/day). Re-subscribes fresh each open,
  // since a previous close already unsubscribed (see _onMenuClosed).
  open(view: CalendarView, use24h: boolean): void {
    this._view = view;
    this._use24h = use24h;
    this._unsubscribe?.();
    // Browse before subscribing: subscribe() delivers the current snapshot synchronously, and
    // if the widget still owned the browse at that point, _render() would read it as "someone
    // else took over" and drop this view back to today.
    this._service.browse(this, needsBrowse(view, new Date()) ? view.month : null);
    this._unsubscribe = this._service.subscribe(snapshot => {
      this._snapshot = snapshot;
      if (!this._applyingView)
        this._render();
    });
    // Our own PopupMenuManager only coordinates menus it manages, not the top bar's (confirmed
    // live: opening the date menu left this one sitting open, underneath it, with a stale grab).
    // Closing ourselves on its open mirrors what sharing one manager would do for free.
    dateMenuPopup()?.disconnectObject(this);
    dateMenuPopup()?.connectObject('open-state-changed', (_menu: unknown, open: boolean) => {
      if (open)
        this.close();
    }, this);
    this._menu.open(BoxPointer.PopupAnimation.FULL);
  }

  close(): void {
    if (this._menu.isOpen)
      this._menu.close(BoxPointer.PopupAnimation.NONE);
  }

  destroy(): void {
    this.close();
    this._menu.disconnectObject(this);
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._menu.destroy();
  }

  private _setView(view: CalendarView): void {
    this._view = view;
    // browse() can itself deliver a synchronous snapshot (a new month's _emit()), which would
    // otherwise re-enter the subscribe callback below and render once there, then again from the
    // unconditional call after - _applyingView makes that first one a no-op, so a real click
    // always renders exactly once, whether or not browse() actually changed anything (a same-month
    // day change is a browse() no-op - see CalendarService.browse's own dedup - and still needs
    // this trailing render to show the new selection).
    this._applyingView = true;
    try {
      this._service.browse(this, needsBrowse(view, new Date()) ? view.month : null);
    } finally {
      this._applyingView = false;
    }
    this._render();
  }

  // Runs on every close, however it happens (Esc, an outside click, an explicit close() from
  // destroy(), or the top-bar date menu opening - via this.open()'s own dateMenuPopup() hook, not
  // PopupMenuManager, which only coordinates menus it manages and doesn't reach the date menu's
  // separate one). Unsubscribes *before* calling _onClosed(), so nothing here reacts to the
  // ownership handoff _onClosed() is about to make; _onClosed() (calendar-popup-controller.ts)
  // then has the widget claim the browse directly - CalendarService.browse() gives it to whoever
  // asks last - so the browse(this, null) below, run after, finds someone else already owns it
  // and is a no-op. That order (not ending our own browse first) is what keeps this to a single
  // range reload instead of one back to today and one back to the browsed month.
  private _onMenuClosed(): void {
    dateMenuPopup()?.disconnectObject(this);
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._onClosed();
    this._service.browse(this, null);
  }

  private _render(): void {
    this._content.destroy_all_children();
    const snapshot = this._snapshot;
    const value = snapshot?.state === 'ready' ? snapshot.value : null;
    if (!value || !value.hasCalendars) {
      this._content.add_child(new St.Label({
        text: snapshot?.state === 'error' ? 'Calendar unavailable' : value ? 'No calendars' : '…',
        style_class: 'desk-cal-empty',
      }));
      this._addOpenApp();
      return;
    }
    const now = new Date();
    const v = this._view;
    const browsing = needsBrowse(v, now);
    const mine = browsing && value.browse !== null && value.browse.owner === this && sameMonth(value.browse.month, v.month);
    if (browsing && !mine) {
      // We've lost our own browse while still needing one: either midnight cleared *every*
      // browse, so nobody's asked for this month since, or another view took it over. Reclaim it in the first
      // case; fall back to today like the widget itself does in the second (fighting another
      // view for ownership would just bounce back and forth). Either branch re-enters _render()
      // synchronously (browse()'s own emit, or _setView()'s explicit render), so this pass builds
      // nothing itself - the content just destroyed above stays empty for one JS tick at most,
      // never actually painted.
      if (value.browse === null)
        this._service.browse(this, v.month);
      else
        this._setView(todayView(now));
      return;
    }
    const range = browsing ? value.browse!.range : value.range;
    const raw = browsing ? value.browse!.events : value.events;
    const events = filterEvents(raw, this._birthdays);

    this._content.add_child(buildNavHeader({
      title: localDate(v.month).format('%B %Y') ?? '',
      onPrev: () => this._setView(stepMonth(v, -1, now)),
      onNext: () => this._setView(stepMonth(v, 1, now)),
      onToday: isToday(v, now) ? null : () => this._setView(todayView(now)),
    }));
    this._content.add_child(buildMonthGrid({
      month: v.month, range, weekStart: value.weekStart, events, now,
      selected: v.day, onDayClicked: day => this._setView(selectDay(day)), variant: 'popup',
    }));
    this._content.add_child(buildDayEvents({
      day: v.day, events, use24h: this._use24h, limit: 6,
      heading: localDate(v.day).format('%A, %B %-d') ?? '',
    }));
    this._addOpenApp();
  }

  // Hidden when GNOME Calendar isn't installed.
  private _addOpenApp(): void {
    const app = Shell.AppSystem.get_default().lookup_app(CALENDAR_APP_ID);
    if (!app)
      return;
    const button = new St.Button({
      style_class: 'desk-cal-popup-open-app', label: 'Open Calendar', can_focus: true,
      x_align: Clutter.ActorAlign.END,
    });
    button.connect('clicked', () => {
      app.activate();
      this.close();
    });
    this._content.add_child(button);
  }
}
