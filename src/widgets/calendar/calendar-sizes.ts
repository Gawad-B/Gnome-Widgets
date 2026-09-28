import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { eventsOnDay, upcomingEvents, type DeskEvent } from '../../core/calendar-math.ts';
import { localDate } from './dates.ts';
import { buildDayEvents, eventLine, eventRow } from './day-events.ts';
import { buildNavHeader } from './nav-header.ts';

export interface SRenderOptions {
  box: St.BoxLayout;
  day: Date;
  now: Date;
  events: readonly DeskEvent[];
  today: boolean;
  onToday: (() => void) | null; // null on today - no pill shown, matching the nav-header pattern
}

// S: the selected day's weekday and number, then its next/first event (or "No events"); off
// today, a Today pill appears under the event line (there's no room for arrows at this size -
// day stepping is scroll-only, wired in calendar.ts).
export function renderS({ box, day, now, events, today, onToday }: SRenderOptions): void {
  box.add_child(new St.Label({
    text: (localDate(day).format('%A') ?? '').toUpperCase(),
    style_class: 'desk-cal-weekday',
    x_align: Clutter.ActorAlign.CENTER,
  }));
  box.add_child(new St.Label({
    text: String(day.getDate()), style_class: 'desk-cal-daynum', x_align: Clutter.ActorAlign.CENTER,
  }));
  if (today) {
    const [next] = upcomingEvents(events, now, 1);
    box.add_child(eventLine(next ? next.summary : 'No events'));
    return;
  }
  const [first] = eventsOnDay(events, day);
  box.add_child(eventLine(first ? first.summary : 'No events'));
  if (onToday) {
    const button = new St.Button({ style_class: 'desk-cal-today-pill', label: 'Today', can_focus: true });
    button.connect('clicked', onToday);
    box.add_child(button);
  }
}

export interface MRenderOptions {
  box: St.BoxLayout;
  day: Date;
  now: Date;
  events: readonly DeskEvent[];
  use24h: boolean;
  today: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: (() => void) | null;
}

// M: ‹ › arrows step a day either side of the weekday/date header; below it, up to 4 of the
// selected day's events (upcoming ones on today, otherwise the whole day - buildDayEvents).
export function renderM({ box, day, now, events, use24h, today, onPrev, onNext, onToday }: MRenderOptions): void {
  const titleBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
  titleBox.add_child(new St.Label({ text: localDate(day).format('%A') ?? '', style_class: 'desk-cal-weekday' }));
  titleBox.add_child(new St.Label({
    text: (localDate(day).format('%B %-d') ?? '').trim(), style_class: 'desk-cal-daynum',
  }));
  box.add_child(buildNavHeader({ title: titleBox, onPrev, onNext, onToday }));

  if (today) {
    const upcoming = upcomingEvents(events, now, 4);
    if (upcoming.length === 0)
      box.add_child(eventLine('No events'));
    else
      for (const e of upcoming)
        box.add_child(eventRow(e, use24h));
  } else {
    box.add_child(buildDayEvents({ day, events, use24h, limit: 4, heading: null }));
  }
}
