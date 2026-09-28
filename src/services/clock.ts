import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { msUntilNext } from '../core/time.ts';
import { Service, type Scheduler } from './service.ts';

export interface ClockValue {
  now: GLib.DateTime;
  use24h: boolean;
}

// Local time, published on every minute (or second) boundary and whenever the
// system 12h/24h setting changes.
export class ClockService extends Service<ClockValue> {
  private readonly _ticks: Scheduler;
  private readonly _periodMs: number;
  private _interface: Gio.Settings | null = null;
  private _tick: number | null = null;

  constructor(scheduler: Scheduler, periodMs: 60_000 | 1_000) {
    super(scheduler);
    this._ticks = scheduler;
    this._periodMs = periodMs;
  }

  protected start(): void {
    this._interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    this._interface.connectObject('changed::clock-format', () => this._emit(), this);
    this._emit();
    // _emit() can synchronously drive the last subscriber to unsubscribe, which stops the
    // service; don't re-arm a tick for a source that already stopped.
    if (!this.running)
      return;
    this._arm();
  }

  protected stop(): void {
    if (this._tick !== null) {
      this._ticks.cancel(this._tick);
      this._tick = null;
    }
    this._interface?.disconnectObject(this);
    this._interface = null;
  }

  private _arm(): void {
    this._tick = this._ticks.schedule(msUntilNext(Date.now(), this._periodMs), () => {
      this._tick = null;
      this._emit();
      // Same guard as start(): a tick can synchronously stop the service via unsubscribe.
      if (!this.running)
        return;
      this._arm();
    });
  }

  private _emit(): void {
    this.publish({
      now: GLib.DateTime.new_now_local(),
      use24h: this._interface?.get_string('clock-format') !== '12h',
    });
  }
}
