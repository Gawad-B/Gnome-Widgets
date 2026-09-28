import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {
  GRID_DAYS, addDays, eventsOnDay, isSameDay, weekdayOrder, type DayRange, type DeskEvent,
} from '../../core/calendar-math.ts';
import { localDate } from './dates.ts';

// A Sunday (Date#getDay() === 0), used only as a peg to read a localized weekday name for a
// given day-of-week number; never shown or compared against itself.
const WEEKDAY_ANCHOR = new Date(2023, 0, 1);

// Takes the first character of the localized abbreviated weekday name (`%a`) as a stand-in for a
// true single-letter weekday initial. That's English-oriented: it reads fine as S/M/T/W/T/F/S in
// English, but in a language where several weekday names share their first letter (Arabic's do -
// every one of them would render as 'ا'), this collapses to indistinguishable columns. The
// Shell's own top-bar calendar avoids that by using its own separately-translated single-letter
// strings rather than truncating the abbreviated name; this widget doesn't have that translation
// infrastructure, so this is a known, English-shaped approximation.
function weekdayInitial(dayOfWeek: number): string {
  const label = localDate(addDays(WEEKDAY_ANCHOR, dayOfWeek)).format('%a') ?? '';
  return label.slice(0, 1).toUpperCase();
}

export interface MonthGridOptions {
  month: Date;              // first of the month this grid is showing
  range: DayRange;          // the six-week grid range (monthGridRange(month, weekStart))
  weekStart: number;
  events: readonly DeskEvent[];
  now: Date;
  selected: Date | null;    // ringed, distinct from today's filled circle
  onDayClicked: ((day: Date) => void) | null;
  variant: 'widget' | 'popup';
}

// A 7x6 month grid for any month: a weekday-initials header row, then GRID_DAYS day cells.
// `range` must already be aligned to `weekStart` (calendar-math's monthGridRange does this), so
// column i here and weekdayOrder(weekStart)[i] name the same day of the week.
export function buildMonthGrid(opts: MonthGridOptions): St.Widget {
  const { month, range, weekStart, events, now, selected, onDayClicked, variant } = opts;
  const layout = new Clutter.GridLayout();
  // Clutter.GridLayout doesn't expand its own non-expanding columns to fill extra allocated
  // width, so an `x_expand: true` grid actor would just leave the 7 columns packed at the left
  // of the extra space. Left at its natural (unexpanded) size and centered instead.
  const styleClasses = variant === 'popup' ? 'desk-cal-grid desk-cal-grid-popup' : 'desk-cal-grid';
  const grid = new St.Widget({
    style_class: styleClasses,
    layout_manager: layout,
    x_expand: false,
    x_align: Clutter.ActorAlign.CENTER,
  });

  weekdayOrder(weekStart).forEach((dow, col) => {
    const label = new St.Label({
      text: weekdayInitial(dow),
      style_class: 'desk-cal-weekday',
      x_align: Clutter.ActorAlign.CENTER,
    });
    layout.attach(label, col, 0, 1, 1);
  });

  const gridMonth = month.getMonth();
  const gridYear = month.getFullYear();
  for (let i = 0; i < GRID_DAYS; i++) {
    const day = addDays(range.begin, i);
    layout.attach(
      dayCell(day, gridMonth, gridYear, now, events, selected, onDayClicked),
      i % 7, 1 + Math.floor(i / 7), 1, 1,
    );
  }
  return grid;
}

function dayCell(
  day: Date, month: number, year: number, now: Date, events: readonly DeskEvent[],
  selected: Date | null, onDayClicked: ((day: Date) => void) | null,
): St.Button {
  const other = day.getMonth() !== month || day.getFullYear() !== year;
  const today = isSameDay(day, now);
  const hasEvents = eventsOnDay(events, day).length > 0;
  const classes = ['desk-cal-day'];
  // Not both: the themed -other colour outranks -today's and would dim today's number (briefly
  // possible at a month boundary, while the calendar snapshot still shows the old month).
  if (other && !today)
    classes.push('desk-cal-day-other');
  if (today)
    classes.push('desk-cal-day-today');
  // The selected-day ring is distinct from today's filled circle, so it's never added on top of
  // it - a selection that happens to be today just shows as today's usual filled circle.
  if (selected && !today && isSameDay(day, selected))
    classes.push('desk-cal-day-selected');

  const fullDate = (localDate(day).format('%A, %B %-d, %Y') ?? '').trim();
  const number = new St.Label({
    text: String(day.getDate()),
    style_class: 'desk-cal-daynum',
    x_align: Clutter.ActorAlign.CENTER,
    accessible_name: fullDate,
  });
  // Always present (so a day without events doesn't shrink the cell), just invisible: opacity
  // rather than `visible`, which a BoxLayout would otherwise exclude from allocation.
  // Centred, or the vertical BoxLayout stretches it to the cell's width (a bar, not a dot).
  const dot = new St.Widget({ style_class: 'desk-cal-day-dot', opacity: hasEvents ? 255 : 0, x_align: Clutter.ActorAlign.CENTER });
  const content = new St.BoxLayout({
    orientation: Clutter.Orientation.VERTICAL,
    x_align: Clutter.ActorAlign.CENTER,
  });
  content.add_child(number);
  content.add_child(dot);

  const button = new St.Button({
    style_class: classes.join(' '),
    child: content,
    can_focus: true,
    accessible_name: fullDate,
  });
  // The button dies with the grid, so no separate teardown is needed for this connection.
  if (onDayClicked)
    button.connect('clicked', () => onDayClicked(day));
  return button;
}
