import GLib from 'gi://GLib';
import type { Scheduler } from './service.ts';

// GLib main-loop timers. Tracks live sources so cancel() never removes an id that already
// fired, and destroy() removes whatever is still pending.
export class GLibScheduler implements Scheduler {
  private readonly _live = new Set<number>();

  schedule(ms: number, fn: () => void): number {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      this._live.delete(id);
      fn();
      return GLib.SOURCE_REMOVE;
    });
    this._live.add(id);
    return id;
  }

  cancel(handle: number): void {
    if (this._live.delete(handle))
      GLib.Source.remove(handle);
  }

  destroy(): void {
    for (const id of this._live)
      GLib.Source.remove(id);
    this._live.clear();
  }
}
