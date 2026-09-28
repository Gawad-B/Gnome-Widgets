import GWeather from 'gi://GWeather?version=4.0';
import { dayKey } from '../core/calendar-math.ts';
import { dailyForecast, formatTemp, nextHours, type DailyForecast, type ForecastPoint } from '../core/forecast.ts';
import { shellWeatherClient, type ShellWeatherClient } from '../shell/shell-private.ts';
import { Service, type Scheduler } from './service.ts';

export type WeatherValue =
  | { status: 'ok'; location: string; temp: string; icon: string; summary: string; hours: ForecastPoint[]; days: DailyForecast[] }
  | { status: 'no-location' }
  | { status: 'no-app' };

const REFRESH_MS = 30 * 60 * 1000;

// Never wait longer than this between local-hour checks: GLib timeouts run on the monotonic
// clock, which pauses across suspend, so a wait armed for "next hour" can fire long after the
// machine actually wakes up in a later hour (or day). Mirrors CalendarService's DAY_CHECK_MS.
const HOUR_CHECK_MS = 60_000;

// The hour `nextHours()`/`dailyForecast()` were last re-sliced for. `info.get_forecast_list()`
// only changes when the Shell client re-fetches (its own 'changed' signal, or our REFRESH_MS
// `client.update()`), but the *slicing* of that same forecast into "next 5 hours"/"5 days from
// today" is relative to `now` and goes stale on its own every time the wall clock crosses into a
// new hour - including across local midnight (yesterday's daily rows) and across a suspend (the
// widget would otherwise keep showing whatever hours were "next" when the machine went to
// sleep). The absolute hour is part of the key so a DST fall-back (Cairo repeats 23:00) still
// counts as a new hour.
const hourKey = (d: Date): string =>
  `${dayKey(d)}-${d.getHours()}-${Math.floor(d.getTime() / 3_600_000)}`;

// Current conditions and forecast from the Shell's own weather client (the top-bar weather,
// using GNOME Weather's locations and units).
export class WeatherService extends Service<WeatherValue> {
  private readonly _ticks: Scheduler;
  private _client: ShellWeatherClient | null = null;
  private _tick: number | null = null;
  private _hourTick: number | null = null;
  private _lastHourKey: string | null = null;
  // Wall-clock (Date.now()) time of the last real data refresh: either a client.update() call
  // (start(), _arm()'s REFRESH_MS timer, or the hour check's own catch-up below) or a 'changed'
  // signal reporting one actually landed. REFRESH_MS's own timer runs on GLib's monotonic clock,
  // which pauses across suspend, so after a long sleep it can be tens of minutes past due before
  // it next fires. This wall-clock stamp lets the hour check (already polling at least every
  // HOUR_CHECK_MS) notice that gap and force a refresh well before the monotonic timer would.
  private _lastUpdateAt: number | null = null;

  constructor(scheduler: Scheduler) {
    super(scheduler);
    this._ticks = scheduler;
  }

  protected start(): void {
    const client = shellWeatherClient();
    if (!client) {
      this.fail(new Error('the Shell weather client is unavailable'));
      return;
    }
    this._client = client;
    client.connectObject('changed', () => this._onRefreshed(), this);
    this._emit();
    // _emit()'s publish() can synchronously drive the last subscriber to unsubscribe (stopping
    // this service — stop() sets this._client back to null) and, if that same round of
    // notifications resubscribes synchronously, to start again with a possibly different
    // client: a nested stop/start within this very call to start(). This._client is then that
    // *new* run's client, not the local `client` this call captured, so bail out here rather
    // than force a refresh or arm a tick for a client this run no longer owns.
    if (this._client !== client)
      return;
    client.update();
    this._lastUpdateAt = Date.now();
    this._arm();
    this._armHourCheck();
  }

  protected stop(): void {
    if (this._tick !== null) {
      this._ticks.cancel(this._tick);
      this._tick = null;
    }
    if (this._hourTick !== null) {
      this._ticks.cancel(this._hourTick);
      this._hourTick = null;
    }
    this._client?.disconnectObject(this);
    this._client = null;
    this._lastHourKey = null;
    this._lastUpdateAt = null;
  }

  // Called wherever this service asks the client to fetch fresh data, or is told fresh data
  // arrived on its own — see _lastUpdateAt's own comment.
  private _onRefreshed(): void {
    this._lastUpdateAt = Date.now();
    this._emit();
  }

  private _arm(): void {
    if (this._tick !== null) {
      this._ticks.cancel(this._tick);
      this._tick = null;
    }
    if (!this.running)
      return;
    this._tick = this._ticks.schedule(REFRESH_MS, () => {
      this._tick = null;
      this._client?.update();
      this._lastUpdateAt = Date.now();
      this._arm();
    });
  }

  // Re-arms a check at most HOUR_CHECK_MS out (never a single long wait for the next hour — see
  // HOUR_CHECK_MS). Cancels any check already pending first (so restarting the service, or a
  // fresh _emit() from a client 'changed' signal in between, never leaves two of these running),
  // and only re-arms while running. Unlike CalendarService's day check, this never needs to skip
  // its own re-arm on the "changed" branch: _emit() here has no arming side effect of its own.
  private _armHourCheck(): void {
    if (this._hourTick !== null)
      this._ticks.cancel(this._hourTick);
    if (!this.running)
      return;
    this._hourTick = this._ticks.schedule(HOUR_CHECK_MS, () => {
      this._hourTick = null;
      // _arm()'s REFRESH_MS timer runs on the monotonic clock, which pauses across suspend: a
      // resume can leave it tens of minutes from firing even though the current temperature is
      // already that stale in wall-clock terms. This poll (already running at least every
      // HOUR_CHECK_MS) catches that by comparing Date.now() against the last real refresh
      // instead, and — unlike _arm() itself, which is left untouched — asks for one right away
      // rather than waiting the rest of REFRESH_MS out.
      if (this._client && this._lastUpdateAt !== null && Date.now() - this._lastUpdateAt >= REFRESH_MS) {
        // Mirrors _arm()'s own timer callback: ask the client to fetch, and record the attempt
        // now rather than waiting for 'changed' to land, so this branch doesn't fire again on
        // every tick while the async update() is still in flight.
        this._client.update();
        this._lastUpdateAt = Date.now();
        // Restart the REFRESH_MS timer from now, so the one left over from before the suspend
        // doesn't fetch again shortly after.
        this._arm();
      }
      // _lastHourKey is always set by the time this can fire: start() calls _emit() (which sets
      // it) before this is first armed, and stop() cancels this tick before clearing it.
      else if (hourKey(new Date()) !== this._lastHourKey)
        this._emit();
      this._armHourCheck();
    });
  }

  private _emit(): void {
    const client = this._client;
    if (!client)
      return;
    // Recorded regardless of which branch below runs, so the hour-check poll always compares
    // against "the hour this service last actually emitted for", not just the 'ok' branch.
    const now = new Date();
    this._lastHourKey = hourKey(now);
    if (!client.available) {
      this.publish({ status: 'no-app' });
      return;
    }
    if (!client.hasLocation) {
      this.publish({ status: 'no-location' });
      return;
    }
    const info = client.info;
    if (!info.is_valid()) {
      // Neither fail() nor publish() runs here, so whatever snapshot was already showing — the
      // initial `loading` state, or the last successful reading — simply stays put until the
      // load finishes and a further 'changed' signal arrives with valid data. The base class
      // has no "stay in loading" republish of its own to call instead.
      if (!client.loading)
        this.fail(new Error('no weather data'));
      return;
    }
    const points: ForecastPoint[] = [];
    for (const fc of info.get_forecast_list()) {
      const [hasTime, time] = fc.get_value_update();
      const [hasTemp, temp] = fc.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
      if (hasTime && hasTemp && time > 0)
        points.push({ time, temp, icon: fc.get_symbolic_icon_name() });
    }
    const [hasCurrentTemp, currentTemp] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
    const conditions = info.get_conditions();
    const sky = info.get_sky();
    this.publish({
      status: 'ok',
      location: info.get_location_name(),
      temp: hasCurrentTemp ? formatTemp(currentTemp) : '–',
      icon: info.get_symbolic_icon_name(),
      // '-' is GWeather's own placeholder for "nothing to report", from both get_conditions()
      // and its get_sky() fallback: treat either as an empty summary rather than displaying it.
      summary: conditions && conditions !== '-' ? conditions : (sky && sky !== '-' ? sky : ''),
      // Re-sliced from the same `points` on every _emit() call, including the hour-check poll's
      // re-emit with no new network data: "next 5 hours"/"5 days from today" are relative to
      // `now`, which is exactly what would otherwise go stale across an hour boundary or a
      // suspend (see hourKey's own comment).
      hours: nextHours(points, now.getTime() / 1000, 5),
      days: dailyForecast(points, now, 5),
    });
  }
}
