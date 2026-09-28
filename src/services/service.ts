// Base class for shared data sources. Ref-counted: the first subscriber starts the
// source and the last one to leave stops it. Failures are retried with backoff while anyone is
// subscribed. No gi:// imports, so it is unit-tested under Node; timers come in as a Scheduler.

export type ServiceState = 'loading' | 'ready' | 'empty' | 'error';

export interface Snapshot<T> {
  readonly state: ServiceState;
  readonly value: T | null;
  readonly error: string | null;
}

export type Listener<T> = (snapshot: Snapshot<T>) => void;

export interface Scheduler {
  schedule(ms: number, fn: () => void): number;
  cancel(handle: number): void;
}

export const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000] as const;

const LOADING: Snapshot<never> = { state: 'loading', value: null, error: null };

const backoff = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;

export abstract class Service<T> {
  private readonly _listeners = new Set<Listener<T>>();
  private readonly _retryScheduler: Scheduler;
  private _snapshot: Snapshot<T> = LOADING;
  private _retryHandle: number | null = null;
  private _attempt = 0;
  // True whenever the concrete source is (or is being) started, from the moment the first
  // subscriber arrives until the last one leaves (or dispose()). Guards publish/publishEmpty/
  // fail so a subclass can never react on behalf of a source that isn't running. Set true
  // before start() runs, so a synchronous publish/fail from inside start() is already seen
  // as happening on a running service.
  private _running = false;

  constructor(scheduler: Scheduler) {
    this._retryScheduler = scheduler;
  }

  get snapshot(): Snapshot<T> {
    return this._snapshot;
  }

  protected get running(): boolean {
    return this._running;
  }

  subscribe(listener: Listener<T>): () => void {
    // Start before adding the listener: a synchronous publish inside start() is then
    // delivered once, by the call below.
    if (this._listeners.size === 0)
      this._invokeStart();
    this._listeners.add(listener);
    listener(this._snapshot);
    return () => this._unsubscribe(listener);
  }

  // Stops the source and forgets every listener (extension disable).
  dispose(): void {
    const running = this._listeners.size > 0;
    this._listeners.clear();
    this._cancelRetry();
    if (running)
      this._invokeStop();
    this._reset();
  }

  protected abstract start(): void;
  protected abstract stop(): void;

  protected publish(value: T): void {
    if (!this._running)
      return;
    // A source that recovered on its own must not be torn down by a stale retry.
    this._cancelRetry();
    this._attempt = 0;
    this._set({ state: 'ready', value, error: null });
  }

  protected publishEmpty(): void {
    if (!this._running)
      return;
    this._set({ state: 'empty', value: null, error: null });
  }

  protected fail(error: unknown): void {
    if (!this._running)
      return;
    this._set({ state: 'error', value: null, error: error instanceof Error ? error.message : String(error) });
    // _set() can synchronously drive the last listener to unsubscribe, which stops the
    // service (_running -> false). A retry must never be scheduled for a source that isn't
    // running, or a later restart (from the retry, then again from a fresh subscribe) fires
    // start() twice.
    if (!this._running || this._retryHandle !== null)
      return;
    const delay = backoff(this._attempt++);
    this._retryHandle = this._retryScheduler.schedule(delay, () => {
      this._retryHandle = null;
      // A throwing stop() must not skip the restart, or the source would sit in its error state
      // with no retry pending.
      try {
        this._invokeStop();
      } catch {
        // _running is already false; the restart below proceeds regardless.
      }
      this._invokeStart();
    });
  }

  private _invokeStart(): void {
    this._running = true;
    // A subclass's start() can throw before it finishes wiring itself up (e.g. a Shell singleton
    // is unavailable partway through). Left unguarded, the throw would propagate out of
    // subscribe() before the listener is added there, leaving _running true with zero listeners:
    // the next subscribe() sees size === 0 and calls start() again, duplicating whatever
    // connectObject()s the first, half-finished call already made, and dispose() would then have
    // nothing to stop (it only stops when listeners.size > 0). Catching here and routing through
    // stop()/fail() instead keeps _running true (fail() requires it) so the normal error snapshot
    // and backoff retry apply, and lets subscribe() continue on to add the listener so the
    // retry's eventual publish still reaches it.
    try {
      this.start();
    } catch (e) {
      try {
        this.stop();
      } catch {
        // stop() itself failing must not stop fail() from reporting the original error below.
      }
      this.fail(e);
    }
  }

  private _invokeStop(): void {
    this._running = false;
    this.stop();
  }

  private _unsubscribe(listener: Listener<T>): void {
    if (!this._listeners.delete(listener) || this._listeners.size > 0)
      return;
    this._cancelRetry();
    this._invokeStop();
    this._reset();
  }

  private _set(snapshot: Snapshot<T>): void {
    this._snapshot = snapshot;
    // A listener that was removed by another listener during this same round must not be
    // notified for it.
    for (const listener of [...this._listeners]) {
      if (this._listeners.has(listener))
        listener(snapshot);
    }
  }

  private _cancelRetry(): void {
    if (this._retryHandle === null)
      return;
    this._retryScheduler.cancel(this._retryHandle);
    this._retryHandle = null;
  }

  private _reset(): void {
    this._snapshot = LOADING;
    this._attempt = 0;
  }
}
