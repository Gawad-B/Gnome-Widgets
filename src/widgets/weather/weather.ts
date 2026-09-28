import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { isSameDay } from '../../core/calendar-math.ts';
import { formatTemp, type DailyForecast, type ForecastPoint } from '../../core/forecast.ts';
import type { Snapshot } from '../../services/service.ts';
import type { WeatherValue } from '../../services/weather.ts';
import { shellWeatherClient } from '../../shell/shell-private.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';

type WeatherOk = Extract<WeatherValue, { status: 'ok' }>;

const ICON_SIZE = { S: 32, M: 28, hourly: 20, daily: 18 } as const;
// The daily range bar's track: fixed-width so the proportional bar inside it can be positioned
// in plain pixels (see _rangeBar()).
const BAR_TRACK_WIDTH = 64;
const BAR_HEIGHT = 4;
const BAR_MIN_WIDTH = 4;

const localDate = (unixSec: number): GLib.DateTime => GLib.DateTime.new_from_unix_local(Math.floor(unixSec));

const formatHour = (unixSec: number, use24h: boolean): string =>
  (localDate(unixSec).format(use24h ? '%H' : '%l %p') ?? '').trim();

const formatWeekday = (day: Date, now: Date): string =>
  isSameDay(day, now) ? 'Today' : (localDate(day.getTime() / 1000).format('%a') ?? '').trim();

// S: location (small, top), the current temperature (large), a condition icon plus its summary,
// then today's H:<max> L:<min> when a forecast day is available.
// M: the S content on the left, plus a row of up to 5 hourly columns (time, icon, temp).
// L: the M content, plus up to 5 daily rows (weekday or "Today", icon, min-max text, and a bar
//    showing that day's min-max span positioned within the week's overall range).
// States: 'loading' and the service's own 'error' get a shared empty-state line, matching
// Calendar's pattern; once ready, the Shell's weather client itself can report 'no-app' or
// 'no-location' instead of a reading.
// Clicking the card (outside edit mode - the edit shield covers the whole card and blocks the
// click there) opens GNOME Weather.
class WeatherWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private _snapshot: Snapshot<WeatherValue> | null = null;
  private _use24h = true;
  private _now = new Date();

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-weather desk-weather-${ctx.size}`,
      reactive: true,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;

    ctx.scope.watch(ctx.hub.weather(), snapshot => {
      this._snapshot = snapshot;
      this._render();
    });
    // Only re-renders when something the rendered content actually depends on changes: the
    // 12h/24h setting, or the local day rolling over (which flips a daily row's "Today" label).
    // Weather itself refreshes rarely, so rebuilding on *that* change is fine, but a
    // plain clock tick happens every minute and must not rebuild the whole card for no visible
    // difference - the same reason Calendar's L grid only rebuilds when its own inputs change.
    ctx.scope.watch(ctx.hub.clock(), ({ value }) => {
      if (!value)
        return;
      const now = new Date(value.now.to_unix() * 1000);
      const changed = value.use24h !== this._use24h || !isSameDay(now, this._now);
      this._use24h = value.use24h;
      this._now = now;
      if (changed)
        this._render();
    });

    // Primary click anywhere on the card opens GNOME Weather. Edit mode's shield is a sibling
    // added directly to the card's own actor, on top of everything (including this widget's
    // actor), so it becomes the pick target and this gesture never recognizes while editing.
    const click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true });
    click.connect('recognize', () => shellWeatherClient()?.activateApp?.());
    box.add_action(click);
    ctx.scope.onCleanup(() => box.remove_action(click));
  }

  private _render(): void {
    this._box.destroy_all_children();
    const snapshot = this._snapshot;
    if (!snapshot || snapshot.state !== 'ready' || !snapshot.value) {
      this._renderMessage(snapshot?.state === 'error' ? 'Weather unavailable' : '…');
      return;
    }
    const value = snapshot.value;
    if (value.status === 'no-app') {
      this._renderMessage('Install GNOME Weather');
      return;
    }
    if (value.status === 'no-location') {
      this._renderMessage('Set a location in GNOME Weather');
      return;
    }

    if (this._size === 'S') {
      this._box.add_child(this._mainColumn(value, ICON_SIZE.S));
      return;
    }
    this._box.add_child(this._middleRow(value));
    if (this._size === 'L' && value.days.length > 0)
      this._box.add_child(this._dailyList(value.days));
  }

  private _renderMessage(text: string): void {
    const label = new St.Label({
      text,
      style_class: 'desk-weather-empty',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      y_expand: true,
    });
    // Wraps instead of ellipsizing: at S width, one line isn't enough to show the full message
    // (e.g. "Set a location in GNOME Weather"), and unlike a location/summary label reused across
    // sizes, there's nothing more useful to fall back to here than the whole sentence.
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_alignment = Pango.Alignment.CENTER;
    this._box.add_child(label);
  }

  // S content, reused as the left column of M and L (with a smaller condition icon there).
  private _mainColumn(value: WeatherOk, iconSize: number): St.BoxLayout {
    const col = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-weather-main' });

    const location = new St.Label({ text: value.location, style_class: 'desk-weather-location' });
    location.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    col.add_child(location);

    col.add_child(new St.Label({ text: value.temp, style_class: 'desk-weather-temp' }));

    const condition = new St.BoxLayout({ style_class: 'desk-weather-condition' });
    condition.add_child(new St.Icon({ icon_name: value.icon, style_class: 'desk-weather-icon', icon_size: iconSize }));
    const summary = new St.Label({
      text: value.summary, style_class: 'desk-weather-summary', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
    });
    summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    condition.add_child(summary);
    col.add_child(condition);

    const [today] = value.days;
    if (today) {
      col.add_child(new St.Label({
        text: `H:${formatTemp(today.max)} L:${formatTemp(today.min)}`, style_class: 'desk-weather-hilo',
      }));
    }
    return col;
  }

  // M's row: the main column plus up to 5 hourly columns (already capped at 5 by the service).
  private _middleRow(value: WeatherOk): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'desk-weather-row', x_expand: true });
    row.add_child(this._mainColumn(value, ICON_SIZE.M));
    if (value.hours.length > 0)
      row.add_child(this._hourlyRow(value.hours));
    return row;
  }

  private _hourlyRow(hours: readonly ForecastPoint[]): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'desk-weather-hourly', x_expand: true });
    for (const point of hours)
      row.add_child(this._hourlyColumn(point));
    return row;
  }

  private _hourlyColumn(point: ForecastPoint): St.BoxLayout {
    const col = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-weather-hour', x_align: Clutter.ActorAlign.CENTER,
    });
    col.add_child(new St.Label({
      text: formatHour(point.time, this._use24h), style_class: 'desk-weather-hour-time', x_align: Clutter.ActorAlign.CENTER,
    }));
    col.add_child(new St.Icon({ icon_name: point.icon, style_class: 'desk-weather-icon', icon_size: ICON_SIZE.hourly }));
    col.add_child(new St.Label({
      text: formatTemp(point.temp), style_class: 'desk-weather-hour-temp', x_align: Clutter.ActorAlign.CENTER,
    }));
    return col;
  }

  // L's daily rows (already capped at 5 by the service), each with a bar showing that day's
  // min-max span placed within the week's overall [weekMin, weekMax] range.
  private _dailyList(days: readonly DailyForecast[]): St.BoxLayout {
    const list = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-weather-daily', x_expand: true });
    const temps = days.flatMap(d => [d.min, d.max]);
    const weekMin = Math.min(...temps);
    const weekMax = Math.max(...temps);
    for (const day of days)
      list.add_child(this._dailyRow(day, weekMin, weekMax));
    return list;
  }

  private _dailyRow(day: DailyForecast, weekMin: number, weekMax: number): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'desk-weather-day-row', x_expand: true });
    row.add_child(new St.Label({
      text: formatWeekday(day.day, this._now), style_class: 'desk-weather-day-name', y_align: Clutter.ActorAlign.CENTER,
    }));
    const icon = new St.Icon({ icon_name: day.icon, style_class: 'desk-weather-icon', icon_size: ICON_SIZE.daily });
    icon.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(icon);
    row.add_child(new St.Label({
      text: `${formatTemp(day.min)}–${formatTemp(day.max)}`, style_class: 'desk-weather-day-range', y_align: Clutter.ActorAlign.CENTER,
    }));
    const bar = this._rangeBar(day, weekMin, weekMax);
    bar.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(bar);
    return row;
  }

  // A BAR_TRACK_WIDTH-px track holding a bar whose position and width place this day's min-max
  // span within the week's overall range. The track has no layout manager: like DeskLayer's own
  // cards (desk-layer.ts positions each with set_position()), an actor with none simply keeps
  // whatever position/size is set on its children directly, which is what a proportional inset
  // bar needs. Sized and positioned here in code rather than via CSS, since a CSS-only width
  // wouldn't be resolved yet at construction time (the theme node isn't ready until the actor is
  // styled/mapped) and this bar's math needs a width to compute against immediately.
  private _rangeBar(day: DailyForecast, weekMin: number, weekMax: number): St.Widget {
    const track = new St.Widget({ style_class: 'desk-weather-day-bar-track' });
    track.set_size(BAR_TRACK_WIDTH, BAR_HEIGHT);
    const bar = new St.Widget({ style_class: 'desk-weather-day-bar' });
    const span = weekMax - weekMin;
    if (span > 0) {
      // Width first (floored at BAR_MIN_WIDTH), then clamp x so x + w never exceeds the track:
      // clamping x before computing w let a day whose min sits at the very top of the week's
      // range (e.g. day.min === weekMax) end up with x === BAR_TRACK_WIDTH and a 0-width bar.
      const w = Math.max(BAR_MIN_WIDTH, Math.round(((day.max - day.min) / span) * BAR_TRACK_WIDTH));
      const rawX = Math.round(((day.min - weekMin) / span) * BAR_TRACK_WIDTH);
      const x = Math.max(0, Math.min(rawX, BAR_TRACK_WIDTH - w));
      bar.set_position(x, 0);
      bar.set_size(w, BAR_HEIGHT);
    } else {
      // Every day in range has the same min and max (or there's only one day): nothing to show
      // proportionally, so fill the whole track rather than drawing a zero-width bar.
      bar.set_position(0, 0);
      bar.set_size(BAR_TRACK_WIDTH, BAR_HEIGHT);
    }
    track.add_child(bar);
    return track;
  }
}

export const weatherWidget: WidgetDefinition = {
  type: 'weather',
  name: 'Weather',
  description: 'Conditions, temperature and forecast',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: {},
  options: [],
  create: ctx => new WeatherWidget(ctx),
};
