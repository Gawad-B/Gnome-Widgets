import type { Listener, Service } from '../services/service.ts';

// Contains a widget's failures. A listener registered through watch() that throws is caught
// and reported through onError (once per scope) instead of unwinding into the service that
// was publishing, or into the layer that owns the card. destroy() work goes through onCleanup
// instead of DeskWidget, so it runs even when the widget itself never finished constructing.
export class WidgetScope {
  private readonly _onError: (error: unknown) => void;
  private readonly _cleanups: Array<() => void> = [];
  private _failed = false;
  private _disposed = false;

  constructor(onError: (error: unknown) => void) {
    this._onError = onError;
  }

  // Subscribes to `service`; an exception from `listener` is caught and reported through
  // onError instead of escaping into Service's own dispatch loop. Ignored once disposed,
  // including when dispose() runs synchronously inside this same call (a failure during the
  // first, synchronous delivery from subscribe()).
  watch<T>(service: Service<T>, listener: Listener<T>): void {
    const unsubscribe = service.subscribe(snapshot => {
      if (this._disposed)
        return;
      try {
        listener(snapshot);
      } catch (e) {
        this._fail(e);
      }
    });
    if (this._disposed) {
      unsubscribe();
      return;
    }
    this._cleanups.push(unsubscribe);
  }

  // Registers teardown work, run once by dispose(). Ignored once disposed.
  onCleanup(fn: () => void): void {
    if (this._disposed)
      return;
    this._cleanups.push(fn);
  }

  // Runs every stored cleanup/unsubscribe, each isolated so one throwing cleanup can't stop
  // the rest. Safe to call more than once, and safe to call from inside a watch() listener:
  // only the first call does anything.
  dispose(): void {
    if (this._disposed)
      return;
    this._disposed = true;
    for (const fn of this._cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error('Desk Widgets: widget cleanup failed', e);
      }
    }
  }

  private _fail(e: unknown): void {
    if (this._failed)
      return;
    this._failed = true;
    this._onError(e);
  }
}
