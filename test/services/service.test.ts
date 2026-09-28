import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Service, type Scheduler, type Snapshot } from '../../src/services/service.ts';

class FakeScheduler implements Scheduler {
  pending = new Map<number, { ms: number; fn: () => void }>();
  cancelled: number[] = [];
  private next = 1;

  schedule(ms: number, fn: () => void): number {
    const handle = this.next++;
    this.pending.set(handle, { ms, fn });
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.pending.delete(handle);
  }

  delays(): number[] {
    return [...this.pending.values()].map(p => p.ms);
  }

  runAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, { fn }] of due)
      fn();
  }
}

class TestService extends Service<number> {
  starts = 0;
  stops = 0;
  publishOnStart: number | null = null;
  failOnStart: unknown = undefined;
  // When set, start() throws this instead of returning normally (left set, it throws again on
  // every later restart too — clear it before a retry to let that restart succeed).
  throwOnStart: unknown = undefined;
  // Sequence log of every start()/stop() call, in order, for asserting call ordering (as opposed
  // to `starts`/`stops`, which only count them) — see the "no duplicate start()" tests below.
  log: string[] = [];

  protected start(): void {
    this.starts++;
    this.log.push('start');
    if (this.throwOnStart !== undefined)
      throw this.throwOnStart;
    if (this.failOnStart !== undefined) {
      this.fail(this.failOnStart);
      return;
    }
    if (this.publishOnStart !== null)
      this.publish(this.publishOnStart);
  }

  protected stop(): void {
    this.stops++;
    this.log.push('stop');
  }

  emit(value: number): void { this.publish(value); }
  empty(): void { this.publishEmpty(); }
  boom(error: unknown): void { this.fail(error); }
  isRunning(): boolean { return this.running; }
}

const setup = () => {
  const scheduler = new FakeScheduler();
  const service = new TestService(scheduler);
  const seen: Snapshot<number>[] = [];
  return { scheduler, service, seen, listen: () => service.subscribe(s => seen.push(s)) };
};

test('first subscriber starts the service and gets the current snapshot', () => {
  const { service, seen, listen } = setup();
  listen();
  listen();
  assert.equal(service.starts, 1);
  assert.deepEqual(seen[0], { state: 'loading', value: null, error: null });
});

test('publish notifies every subscriber', () => {
  const { service, seen, listen } = setup();
  listen();
  service.emit(42);
  assert.deepEqual(seen.at(-1), { state: 'ready', value: 42, error: null });
  assert.deepEqual(service.snapshot, { state: 'ready', value: 42, error: null });
});

test('a synchronous publish during start reaches the first subscriber exactly once', () => {
  const { service, seen, listen } = setup();
  service.publishOnStart = 7;
  listen();
  assert.deepEqual(seen, [{ state: 'ready', value: 7, error: null }]);
});

test('last unsubscribe stops and resets; a new subscriber starts again', () => {
  const { service, listen } = setup();
  const a = listen();
  const b = listen();
  service.emit(1);
  a();
  assert.equal(service.stops, 0);
  b();
  b();
  assert.equal(service.stops, 1);
  assert.equal(service.snapshot.state, 'loading');
  listen();
  assert.equal(service.starts, 2);
});

test('publishEmpty reports the empty state', () => {
  const { service, seen, listen } = setup();
  listen();
  service.empty();
  assert.deepEqual(seen.at(-1), { state: 'empty', value: null, error: null });
});

test('fail reports the error and retries with backoff', () => {
  const { scheduler, service, seen, listen } = setup();
  listen();
  service.boom(new Error('bus gone'));
  assert.deepEqual(seen.at(-1), { state: 'error', value: null, error: 'bus gone' });
  assert.deepEqual(scheduler.delays(), [30_000]);

  scheduler.runAll();
  assert.equal(service.stops, 1);
  assert.equal(service.starts, 2);

  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    service.boom('again');
    delays.push(...scheduler.delays());
    scheduler.runAll();
  }
  assert.deepEqual(delays, [60_000, 300_000, 900_000, 900_000]);

  service.emit(5);
  service.boom('after success');
  assert.deepEqual(scheduler.delays(), [30_000]);
});

test('a failure while a retry is pending does not stack retries', () => {
  const { scheduler, service, listen } = setup();
  listen();
  service.boom('one');
  service.boom('two');
  assert.equal(scheduler.pending.size, 1);
});

test('unsubscribing cancels a pending retry', () => {
  const { scheduler, service, listen } = setup();
  const off = listen();
  service.boom('x');
  off();
  assert.equal(scheduler.pending.size, 0);
  assert.equal(scheduler.cancelled.length, 1);
});

test('fail with no subscribers does not schedule a retry', () => {
  const { scheduler, service } = setup();
  service.boom('x');
  assert.equal(scheduler.pending.size, 0);
});

test('dispose stops, drops listeners and cancels retries', () => {
  const { scheduler, service, seen, listen } = setup();
  listen();
  service.boom('x');
  const before = seen.length;
  service.dispose();
  service.emit(3);
  assert.equal(seen.length, before);
  assert.equal(service.stops, 1);
  assert.equal(scheduler.pending.size, 0);
});

// --- Fix round 1 regressions -------------------------------------------------------------

test('a synchronous fail during start on the first subscribe still schedules a retry', () => {
  const { scheduler, service, seen, listen } = setup();
  service.failOnStart = new Error('boom');
  listen();
  assert.deepEqual(seen, [{ state: 'error', value: null, error: 'boom' }]);
  assert.deepEqual(scheduler.delays(), [30_000]);
});

test('a listener that unsubscribes the last subscription during a publish stops the service once, and a later publish is inert', () => {
  const { service, seen } = setup();
  let off: (() => void) | null = null;
  off = service.subscribe(s => {
    seen.push(s);
    if (s.state === 'ready')
      off!();
  });
  service.emit(1);
  assert.equal(service.stops, 1);
  assert.equal(service.snapshot.state, 'loading');

  const before = seen.length;
  service.emit(2);
  assert.equal(seen.length, before);
  assert.equal(service.snapshot.state, 'loading');
});

test('a listener that unsubscribes another during a publish does not notify the removed one for that round', () => {
  const { service, seen } = setup();
  const bSeen: Snapshot<number>[] = [];
  let offB: (() => void) | null = null;
  service.subscribe(s => {
    seen.push(s);
    if (s.state === 'ready')
      offB!();
  });
  offB = service.subscribe(s => bSeen.push(s));

  service.emit(9);

  assert.equal(seen.filter(s => s.state === 'ready').length, 1);
  assert.equal(bSeen.filter(s => s.state === 'ready').length, 0);
});

test('a successful publish after a failure cancels the pending retry', () => {
  const { scheduler, service, listen } = setup();
  listen();
  service.boom('x');
  assert.equal(scheduler.pending.size, 1);
  service.emit(5);
  assert.equal(scheduler.pending.size, 0);
});

test('dispose then a stray publish leaves the snapshot at loading', () => {
  const { service, listen } = setup();
  listen();
  service.emit(1);
  service.dispose();
  service.emit(3);
  assert.equal(service.snapshot.state, 'loading');
});

// --- Fix round 2 regressions -------------------------------------------------------------

test('unsubscribing on the error snapshot does not leave a stale retry scheduled, and a later subscribe restarts cleanly', () => {
  const { scheduler, service } = setup();
  let off: (() => void) | null = null;
  off = service.subscribe(s => {
    if (s.state === 'error')
      off!();
  });

  service.boom('x');
  assert.equal(scheduler.pending.size, 0);
  assert.equal(service.stops, 1);

  service.subscribe(() => {});
  assert.equal(service.starts, 2);
});

test('unsubscribing and resubscribing during a synchronous publish inside a retry-restart still leaves the service running', () => {
  const { scheduler, service } = setup();
  let restarted = false;
  const newSeen: Snapshot<number>[] = [];
  let off: (() => void) | null = null;

  off = service.subscribe(s => {
    // Ignore the initial "loading" delivery; react only to the retry-restart's republish.
    if (s.state === 'ready' && restarted) {
      off!();
      service.subscribe(s2 => newSeen.push(s2));
    }
  });

  service.boom('x'); // schedules a 30_000 ms retry
  restarted = true;
  service.publishOnStart = 42; // the restart's start() will publish synchronously
  scheduler.runAll(); // fires the retry: stop() then start()

  assert.deepEqual(newSeen, [{ state: 'ready', value: 42, error: null }]);
  assert.equal(service.isRunning(), true);
});

// --- Fix round 3: a throwing start() is never left uncleaned-up --------------------------

test('a throwing start() on first subscribe is caught, stopped, and reported as a normal error with backoff', () => {
  const { scheduler, service, seen, listen } = setup();
  service.throwOnStart = new Error('boom');
  listen();

  // start() ran (and threw) exactly once, and was cleaned up with a matching stop() before
  // fail() ran — not left "running" with the connections start() may have partly made.
  assert.equal(service.starts, 1);
  assert.equal(service.stops, 1);
  // The listener was still added despite the throw, so it receives the resulting error snapshot.
  assert.deepEqual(seen, [{ state: 'error', value: null, error: 'boom' }]);
  assert.deepEqual(scheduler.delays(), [30_000]);
});

test('a throwing start()\'s scheduled retry restarts the service, and a later publish reaches the listener that subscribed through the failure', () => {
  const { scheduler, service, seen, listen } = setup();
  service.throwOnStart = new Error('boom');
  listen();
  service.throwOnStart = undefined; // the retry's start() succeeds this time
  scheduler.runAll(); // fires the retry: stop() then start()

  assert.equal(service.starts, 2);
  service.emit(5);
  assert.deepEqual(seen.at(-1), { state: 'ready', value: 5, error: null });
});

test('a start() that keeps throwing across repeated retries is always stopped before its next start(), never duplicating a running source', () => {
  const { scheduler, service, listen } = setup();
  service.throwOnStart = new Error('boom');
  listen();
  for (let i = 0; i < 3; i++)
    scheduler.runAll(); // each retry: stop() then start(), which throws again

  // Walk the log and check every 'start' (other than the very first) is immediately preceded by
  // a 'stop' — i.e. start() never runs twice back-to-back without a stop() in between, which is
  // exactly the "duplicate connectObjects on the next subscribe" bug this guards against.
  assert.ok(service.log.filter(e => e === 'start').length >= 4, service.log.join(','));
  for (let i = 1; i < service.log.length; i++) {
    if (service.log[i] === 'start')
      assert.equal(service.log[i - 1], 'stop', `start at log[${i}] not preceded by a stop: ${service.log.join(',')}`);
  }
});

test('dispose after a throwing start() cancels the pending retry, stops cleanly, and leaves nothing running', () => {
  const { scheduler, service, listen } = setup();
  service.throwOnStart = new Error('boom');
  listen();
  service.dispose();

  assert.equal(scheduler.pending.size, 0);
  assert.equal(service.isRunning(), false);
  assert.equal(service.snapshot.state, 'loading');

  // A stray publish after dispose (as if a lingering async callback fired late) must be inert.
  service.throwOnStart = undefined;
  service.emit(9);
  assert.equal(service.snapshot.state, 'loading');
});
