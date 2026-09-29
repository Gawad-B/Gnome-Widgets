import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PositionPoll } from '../../src/core/position-poll.ts';
import type { Scheduler } from '../../src/services/service.ts';

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

  // Fires the single pending timer (asserts there is exactly one, since every test here reasons
  // about one loop's worth of ticks at a time).
  fireOne(): void {
    assert.equal(this.pending.size, 1, `expected exactly one pending timer, found ${this.pending.size}`);
    const [handle, { fn }] = [...this.pending.entries()][0]!;
    this.pending.delete(handle);
    fn();
  }

  delays(): number[] {
    return [...this.pending.values()].map(p => p.ms);
  }
}

// A fetch whose promise the test controls by hand, to simulate a call still "in flight" across
// several synchronous poll operations before letting it resolve.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// Lets every already-settled promise's reaction chain run to completion, including the extra
// microtask hop an `async` fetch mock adds when it returns another promise rather than a plain
// value. More ticks than any chain in these tests actually needs, so this stays robust to that
// detail rather than depending on counting hops exactly.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await Promise.resolve();
}

test('normal operation: each tick fetches, reports, and reschedules exactly one timer', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  const poll = new PositionPoll(scheduler, async gen => gen * 10, v => results.push(v), 1000);

  poll.setWanted(true, 1000);
  assert.equal(scheduler.pending.size, 1);
  scheduler.fireOne();
  await flush();

  assert.deepEqual(results, [10]);
  assert.equal(scheduler.pending.size, 1, 'a fresh tick is scheduled after a successful fetch');
});

test('stall: a target change while a call is in flight still gets a fresh tick scheduled, and the stale reply is ignored', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  const inFlight: { promise: Promise<number | null>; resolve: (v: number | null) => void }[] = [];
  const poll = new PositionPoll(scheduler, async () => {
    const d = deferred<number | null>();
    inFlight.push(d);
    return d.promise;
  }, v => results.push(v), 1000);

  poll.setWanted(true, 1000);
  scheduler.fireOne(); // dispatches the first fetch; it never resolves on its own in this test
  assert.equal(inFlight.length, 1);
  assert.equal(scheduler.pending.size, 0, 'no timer is pending while the fetch is in flight');

  // The active target changes (a different player, or a track change) while that fetch is still
  // outstanding. Without reset(), nothing would ever schedule another tick, since setWanted's
  // wanted flag never flipped off (if _armPoll returned early because polling was
  // still wanted the whole time).
  poll.reset();
  assert.equal(scheduler.pending.size, 1, 'reset() schedules a fresh tick immediately rather than waiting on the stale call');

  // The stale call for the old target finally answers.
  inFlight[0]!.resolve(999);
  await flush();
  assert.deepEqual(results, [], 'the stale reply must never be reported');
  assert.equal(scheduler.pending.size, 1, 'the stale reply must not add a second timer');

  // The fresh tick fires and its own reply is reported normally.
  scheduler.fireOne();
  assert.equal(inFlight.length, 2);
  inFlight[1]!.resolve(42);
  await flush();
  assert.deepEqual(results, [42]);
  assert.equal(scheduler.pending.size, 1, 'polling continues normally after the reset');
});

test('double loop: owner count 1 -> 0 -> 1 while a call is in flight ends with exactly one live timer', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  const inFlight: { promise: Promise<number | null>; resolve: (v: number | null) => void }[] = [];
  const poll = new PositionPoll(scheduler, async () => {
    const d = deferred<number | null>();
    inFlight.push(d);
    return d.promise;
  }, v => results.push(v), 1000);

  poll.setWanted(true, 1000);
  scheduler.fireOne();
  assert.equal(inFlight.length, 1);

  // Owner count drops to zero mid-flight: no timer is pending (the call itself can't be
  // cancelled from here), so there is nothing to cancel yet.
  poll.setWanted(false, 1000);
  assert.equal(scheduler.pending.size, 0);

  // Owner count comes back before the stale call answers.
  poll.setWanted(true, 1000);
  assert.equal(scheduler.pending.size, 1, 'restarting schedules exactly one fresh timer');

  // The stale call (from before the stop) now answers.
  inFlight[0]!.resolve(1);
  await flush();
  assert.deepEqual(results, [], 'the stale call from before the restart must not report or reschedule');
  assert.equal(scheduler.pending.size, 1, 'still exactly one timer: the stale call did not add a second loop');

  // The fresh loop's own tick behaves normally.
  scheduler.fireOne();
  inFlight[1]!.resolve(7);
  await flush();
  assert.deepEqual(results, [7]);
  assert.equal(scheduler.pending.size, 1);
});

test('a failed fetch reschedules without reporting a result', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  let call = 0;
  const poll = new PositionPoll(scheduler, async () => {
    call++;
    if (call === 1)
      throw new Error('boom');
    return 5;
  }, v => results.push(v), 1000);

  poll.setWanted(true, 1000);
  scheduler.fireOne();
  await flush();
  assert.deepEqual(results, [], 'a failure is never reported as a result');
  assert.equal(scheduler.pending.size, 1, 'a failure still reschedules the next tick');

  scheduler.fireOne();
  await flush();
  assert.deepEqual(results, [5]);
});

test('stopping while a call is in flight never reports or reschedules, even without a later reset', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  const d = deferred<number | null>();
  const poll = new PositionPoll(scheduler, async () => d.promise, v => results.push(v), 1000);

  poll.setWanted(true, 1000);
  scheduler.fireOne();
  poll.stop();
  d.resolve(123);
  await flush();
  assert.deepEqual(results, []);
  assert.equal(scheduler.pending.size, 0);
});

test('pause -> play: a pending tick is rescheduled at the new interval, resuming within 1 s', () => {
  const scheduler = new FakeScheduler();
  const poll = new PositionPoll(scheduler, async () => null, () => {}, 1000);
  // Paused: the tick already pending waits the slower 5 s.
  poll.setWanted(true, 5000);
  assert.deepEqual(scheduler.delays(), [5000]);
  const pausedHandle = [...scheduler.pending.keys()][0];

  // Playback resumes before that 5 s tick ever fires.
  poll.setWanted(true, 1000);
  assert.deepEqual(scheduler.delays(), [1000], 'the pending tick now waits the faster 1 s, not the stale 5 s');
  assert.ok(scheduler.cancelled.includes(pausedHandle!), 'the old, slower-scheduled tick was cancelled');
  assert.equal(scheduler.pending.size, 1, 'exactly one tick is pending, not two');
});

test('changing the interval while a call is in flight leaves that call alone', async () => {
  const scheduler = new FakeScheduler();
  const results: (number | null)[] = [];
  const poll = new PositionPoll(scheduler, async () => 3, v => results.push(v), 1000);
  poll.setWanted(true, 1000);
  scheduler.fireOne(); // dispatches the fetch; nothing is pending while it's "in flight"
  assert.equal(scheduler.pending.size, 0);

  // Paused mid-fetch: there is no pending timer to reschedule, so this is a pure no-op for
  // scheduling — the fetch already running keeps running, uninterrupted.
  poll.setWanted(true, 5000);
  assert.equal(scheduler.pending.size, 0, 'still nothing pending: the in-flight call was not touched');

  await flush();
  assert.deepEqual(results, [3], 'the in-flight call completed normally');
  assert.deepEqual(scheduler.delays(), [5000], 'the next tick uses the interval now in effect');
});

test('reset() while not running just bumps state and schedules nothing', () => {
  const scheduler = new FakeScheduler();
  const poll = new PositionPoll(scheduler, async () => null, () => {}, 1000);
  poll.reset();
  assert.equal(scheduler.pending.size, 0);
  assert.equal(poll.running, false);
});
