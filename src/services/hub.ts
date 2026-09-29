import { BatteryService } from './battery.ts';
import { CalendarService } from './calendar.ts';
import { ClockService } from './clock.ts';
import { GLibScheduler } from './glib-scheduler.ts';
import { MediaService } from './media.ts';
import { SystemService } from './system.ts';
import { TaskStore } from './task-store.ts';
import { WeatherService } from './weather.ts';

// Owns the shared data services. Each is created on first request; destroy() stops them all.
export class ServiceHub {
  private readonly _scheduler = new GLibScheduler();
  private _clock: ClockService | null = null;
  private _clockSeconds: ClockService | null = null;
  private _calendar: CalendarService | null = null;
  private _weather: WeatherService | null = null;
  private _system: SystemService | null = null;
  private _battery: BatteryService | null = null;
  private _tasks: TaskStore | null = null;
  private _media: MediaService | null = null;

  clock(): ClockService {
    return (this._clock ??= new ClockService(this._scheduler, 60_000));
  }

  clockSeconds(): ClockService {
    return (this._clockSeconds ??= new ClockService(this._scheduler, 1_000));
  }

  calendar(): CalendarService {
    return (this._calendar ??= new CalendarService(this._scheduler));
  }

  weather(): WeatherService {
    return (this._weather ??= new WeatherService(this._scheduler));
  }

  system(): SystemService {
    return (this._system ??= new SystemService(this._scheduler));
  }

  battery(): BatteryService {
    return (this._battery ??= new BatteryService(this._scheduler));
  }

  tasks(): TaskStore {
    return (this._tasks ??= new TaskStore(this._scheduler));
  }

  media(): MediaService {
    return (this._media ??= new MediaService(this._scheduler));
  }

  destroy(): void {
    this._clock?.dispose();
    this._clockSeconds?.dispose();
    this._calendar?.dispose();
    this._weather?.dispose();
    this._system?.dispose();
    this._battery?.dispose();
    this._tasks?.dispose();
    this._media?.dispose();
    this._clock = null;
    this._clockSeconds = null;
    this._calendar = null;
    this._weather = null;
    this._system = null;
    this._battery = null;
    this._tasks = null;
    this._media = null;
    this._scheduler.destroy();
  }
}
