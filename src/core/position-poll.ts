// A single-flight, generation-guarded repeating poll: `fetch()` runs every `intervalMs` while
// wanted, but a completion only ever takes effect if it belongs to the still-current
// generation. That is what lets a target swap (a different active player, or the same player's
// next track) or a fast stop/start invalidate whatever is already in flight outright — checking
// only "is the poll still wanted" can't tell a stale in-flight call from the run that's supposed
// to replace it, which is what let two ticks end up scheduled at once, or let a stalled call
// leave nothing scheduled at all. Pure and gi-free — unit-tested under Node — driven only
// through the injected Scheduler (services/service.ts, itself gi-free).
import type { Scheduler } from '../services/service.ts';

export class PositionPoll {
  private readonly _scheduler: Scheduler;
  private readonly _fetch: (generation: number) => Promise<number | null>;
  private readonly _onResult: (value: number | null) => void;
  private _running = false;
  private _intervalMs: number;
  private _generation = 0;
  private _tick: number | null = null;

  constructor(
    scheduler: Scheduler,
    fetch: (generation: number) => Promise<number | null>,
    onResult: (value: number | null) => void,
    intervalMs: number,
  ) {
    this._scheduler = scheduler;
    this._fetch = fetch;
    this._onResult = onResult;
    this._intervalMs = intervalMs;
  }

  get running(): boolean {
    return this._running;
  }

  // Whether the poll should currently be running, and the interval future ticks should use.
  // Turning it on when it was off starts a fresh generation, so nothing already in flight from
  // before can land as this new run's result. Turning it on again while already on (e.g. Paused
  // going back to Playing) reschedules the pending tick at the new interval, if one is pending —
  // otherwise a slower Paused-era wait would keep the next poll waiting out its old, longer
  // delay even after playback resumed. A call already in flight is left alone regardless: there
  // is nothing to reschedule until it (or a reset()) finishes.
  setWanted(wanted: boolean, intervalMs: number): void {
    const intervalChanged = intervalMs !== this._intervalMs;
    this._intervalMs = intervalMs;
    if (wanted === this._running) {
      if (this._running && intervalChanged && this._tick !== null)
        this._scheduleNext();
      return;
    }
    this._running = wanted;
    if (wanted) {
      this._generation++;
      this._scheduleNext();
    } else {
      this._cancelTimer();
    }
  }

  // The target changed (a different active player, or the same player's track): whatever is
  // already in flight belongs to the old target and must never be allowed to land or reschedule
  // on its own. Restarts right away when still wanted, rather than waiting on that stale call,
  // which may be slow or may never come back at all.
  reset(): void {
    this._generation++;
    if (this._running)
      this._scheduleNext();
    else
      this._cancelTimer();
  }

  // Final teardown.
  stop(): void {
    this._running = false;
    this._generation++;
    this._cancelTimer();
  }

  private _cancelTimer(): void {
    if (this._tick !== null) {
      this._scheduler.cancel(this._tick);
      this._tick = null;
    }
  }

  private _scheduleNext(): void {
    this._cancelTimer();
    const generation = this._generation;
    this._tick = this._scheduler.schedule(this._intervalMs, () => {
      this._tick = null;
      void this._run(generation);
    });
  }

  private async _run(generation: number): Promise<void> {
    let value: number | null;
    try {
      value = await this._fetch(generation);
    } catch {
      // The fetch callback is responsible for its own failure logging. A failed attempt still
      // reschedules — it doesn't stop the poll, and it doesn't overwrite the last known result.
      if (this._running && generation === this._generation)
        this._scheduleNext();
      return;
    }
    if (!this._running || generation !== this._generation)
      return;
    this._onResult(value);
    this._scheduleNext();
  }
}
