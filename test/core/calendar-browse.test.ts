import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarBrowseState } from '../../src/core/calendar-browse.ts';
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

  delays(): number[] {
    return [...this.pending.values()].map(p => p.ms);
  }

  // Fires every pending timer, oldest first - same shape as service.test.ts's own runAll().
  runAll(): void {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, { fn }] of due)
      fn();
  }
}

const HOLD_MS = 2_000;
const OWNER_A = { name: 'A' };
const OWNER_B = { name: 'B' };
const SEP = new Date(2026, 8, 1);
const NOV = new Date(2026, 10, 1);

const setup = () => {
  const scheduler = new FakeScheduler();
  let expired = 0;
  const state = new CalendarBrowseState(scheduler, HOLD_MS, () => { expired++; });
  return { scheduler, state, expired: () => expired };
};

test('a new owner takes over browsing from another (last caller wins)', () => {
  const { state } = setup();
  assert.deepEqual(state.request(OWNER_A, SEP, false), { kind: 'start', month: SEP });
  assert.deepEqual(state.target, { owner: OWNER_A, month: SEP });

  assert.deepEqual(state.request(OWNER_B, NOV, false), { kind: 'start', month: NOV });
  assert.deepEqual(state.target, { owner: OWNER_B, month: NOV });
});

test('the same owner re-requesting the month it already has is a no-op', () => {
  const { state } = setup();
  state.request(OWNER_A, SEP, false);
  assert.deepEqual(state.request(OWNER_A, new Date(SEP.getTime()), false), { kind: 'none' });
  assert.deepEqual(state.target, { owner: OWNER_A, month: SEP });
});

test('ending someone else\'s browse is a no-op', () => {
  const { state } = setup();
  state.request(OWNER_A, SEP, false);
  assert.deepEqual(state.request(OWNER_B, null, true), { kind: 'none' });
  assert.deepEqual(state.target, { owner: OWNER_A, month: SEP });
  assert.equal(state.holding, false);
});

test('the caller\'s endsBrowse flag (the current month) ends the browse just like null does, and arms the hold', () => {
  const { state, scheduler } = setup();
  state.request(OWNER_A, SEP, false);
  // The caller (CalendarService.browse) reduces "the browsed month equals today's" to
  // endsBrowse=true before calling here - this is that call, not a literal current-month Date.
  const result = state.request(OWNER_A, null, true);
  assert.deepEqual(result, { kind: 'end' });
  assert.equal(state.target, null);
  assert.equal(state.holding, true);
  assert.deepEqual(scheduler.delays(), [HOLD_MS]);
});

test('an empty read over the same range is held back while the hold is up', () => {
  const { state } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true); // ends it, arms the hold
  assert.equal(state.admitRead(/* sameRange */ true, /* nonEmpty */ false), false);
  assert.equal(state.holding, true, 'the hold survives an empty read on the same range');
});

test('a non-empty read is always admitted and ends the hold outright', () => {
  const { state, scheduler } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true);
  assert.equal(scheduler.pending.size, 1);

  assert.equal(state.admitRead(true, true), true);
  assert.equal(state.holding, false);
  assert.equal(scheduler.pending.size, 0, 'the fallback timer is cancelled once the hold clears');
});

test('a range change is admitted regardless of the hold, without clearing it by itself', () => {
  const { state } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true);
  assert.equal(state.admitRead(/* sameRange */ false, /* nonEmpty */ false), true);
  assert.equal(state.holding, true, 'only a non-empty read ends the hold outright');
});

test('the hold releases on its own via the fallback timer once it fires', () => {
  const { state, scheduler, expired } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true);
  assert.equal(state.holding, true);

  scheduler.runAll();
  assert.equal(state.holding, false);
  assert.equal(expired(), 1);
});

test('a re-arm (a second end in quick succession) cancels the first timer and restarts the window', () => {
  const { state, scheduler } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true);
  const firstHandle = [...scheduler.pending.keys()][0]!;

  state.request(OWNER_A, NOV, false); // browse again
  state.request(OWNER_A, null, true); // end again - re-arms

  assert.equal(scheduler.pending.size, 1, 'still only one timer pending, not stacked');
  assert.ok(scheduler.cancelled.includes(firstHandle), 'the first window\'s timer was cancelled');
});

test('a hold released early by a real read is not also fired later by its now-stale timer', () => {
  const { state, scheduler, expired } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true);
  state.admitRead(true, true); // the real reload lands - clears the hold and cancels the timer
  assert.equal(scheduler.pending.size, 0);
  assert.equal(expired(), 0, 'onHoldExpired never fires for a hold that already cleared');
});

test('midnight ends an active browse and holds, but is a no-op with nothing to end', () => {
  const { state, scheduler } = setup();
  assert.equal(state.endForMidnight(), false, 'nothing was browsing');
  assert.equal(scheduler.pending.size, 0);

  state.request(OWNER_A, SEP, false);
  assert.equal(state.endForMidnight(), true);
  assert.equal(state.target, null);
  assert.equal(state.holding, true);
  assert.equal(scheduler.pending.size, 1);
});

test('clear() (stop()) drops the browse and the hold with no timer left pending', () => {
  const { state, scheduler } = setup();
  state.request(OWNER_A, SEP, false);
  state.request(OWNER_A, null, true); // holding, timer armed

  state.clear();
  assert.equal(state.target, null);
  assert.equal(state.holding, false);
  assert.equal(scheduler.pending.size, 0);

  // And clear() while nothing is browsing or held is harmless.
  state.clear();
  assert.equal(state.target, null);
  assert.equal(state.holding, false);
});
