import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { eventsOnDay, isAllDay, upcomingEvents, type DeskEvent } from '../../core/calendar-math.ts';
import { localDate } from './dates.ts';

// EDS gives every event from the built-in "Birthdays & Anniversaries" calendar an id starting
// with this source uid, followed by a newline.
const BIRTHDAY_SOURCE_PREFIX = 'birthdays\n';

const isBirthdayEvent = (e: DeskEvent): boolean => e.id.startsWith(BIRTHDAY_SOURCE_PREFIX);

// Shared by the widget and the popup, so the birthdays prefix lives in one place.
export const filterEvents = (events: readonly DeskEvent[], showBirthdays: boolean): DeskEvent[] =>
  showBirthdays ? [...events] : events.filter(e => !isBirthdayEvent(e));

export function formatEventTime(e: DeskEvent, use24h: boolean): string {
  if (isAllDay(e))
    return 'All day';
  return (localDate(e.start).format(use24h ? '%H:%M' : '%l:%M %p') ?? '').trim();
}

// A single ellipsized line standing in for an event row, used for the S summary and for "No
// events" wherever a list would otherwise be empty.
export function eventLine(text: string): St.Label {
  const label = new St.Label({ text, style_class: 'desk-cal-event', x_expand: true });
  label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
  return label;
}

export function eventRow(e: DeskEvent, use24h: boolean): St.BoxLayout {
  const row = new St.BoxLayout({ x_expand: true });
  const bar = new St.Widget({ style_class: 'desk-cal-event-bar' });
  const time = new St.Label({ text: formatEventTime(e, use24h), style_class: 'desk-cal-event-time' });
  const summary = new St.Label({ text: e.summary, style_class: 'desk-cal-event', x_expand: true });
  summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
  row.add_child(bar);
  row.add_child(time);
  row.add_child(summary);
  return row;
}

export interface DayEventsOptions {
  day: Date;
  events: readonly DeskEvent[];
  use24h: boolean;
  limit: number;
  heading: string | null;
}

// The selected day's events (all-day first, then timed - eventsOnDay's own compareUpcoming
// already orders them that way), with an optional heading (e.g. "Mon, Sep 28"). Shared by the
// L widget's non-today detail section and the popup.
export function buildDayEvents({ day, events, use24h, limit, heading }: DayEventsOptions): St.BoxLayout {
  const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
  if (heading)
    box.add_child(new St.Label({ text: heading, style_class: 'desk-cal-weekday' }));
  const list = eventsOnDay(events, day);
  if (list.length === 0)
    box.add_child(eventLine('No events'));
  else
    for (const e of list.slice(0, limit))
      box.add_child(eventRow(e, use24h));
  return box;
}

export interface DayDetailOptions {
  day: Date;
  now: Date;
  today: boolean;
  events: readonly DeskEvent[];
  use24h: boolean;
  limit: number;
}

// The L widget's detail section below the grid: on today, today's events, or the pre-existing
// "Upcoming" fallback when today has none; otherwise the selected day's events with a heading
// (buildDayEvents above).
export function buildDayDetail({ day, now, today, events, use24h, limit }: DayDetailOptions): St.BoxLayout {
  if (!today)
    return buildDayEvents({ day, events, use24h, limit, heading: localDate(day).format('%a, %b %-d') ?? '' });

  const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
  const todaysEvents = eventsOnDay(events, now).slice(0, limit);
  const showingToday = todaysEvents.length > 0;
  const list = showingToday ? todaysEvents : upcomingEvents(events, now, limit);
  if (!showingToday)
    box.add_child(new St.Label({ text: 'Upcoming', style_class: 'desk-cal-weekday' }));
  if (list.length === 0)
    box.add_child(eventLine('No events'));
  else
    for (const e of list)
      box.add_child(eventRow(e, use24h));
  return box;
}

// The shared empty/error/loading state: a single centred, word-wrapped
// line, added directly to `box`. Wraps instead of ellipsizing (matches Weather's own version) - at
// S width, one line isn't enough for e.g. "Calendar unavailable" without cutting it off.
export function renderEmptyMessage(box: St.BoxLayout, text: string): void {
  const label = new St.Label({
    text,
    style_class: 'desk-cal-empty',
    x_align: Clutter.ActorAlign.CENTER,
    y_align: Clutter.ActorAlign.CENTER,
    x_expand: true,
    y_expand: true,
  });
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  label.clutter_text.line_alignment = Pango.Alignment.CENTER;
  box.add_child(label);
}
