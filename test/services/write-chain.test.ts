import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentWrite, enqueueWrite } from '../../src/services/write-chain.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('writes for one key run in order, each after the previous settles', async () => {
  const order: string[] = [];
  const a = enqueueWrite('k1', async () => { await tick(); order.push('a'); });
  const b = enqueueWrite('k1', async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
});

test('a rejected write does not block later ones, and currentWrite still settles', async () => {
  const failed = enqueueWrite('k2', async () => { throw new Error('disk full'); });
  await assert.rejects(failed);
  let ran = false;
  await enqueueWrite('k2', async () => { ran = true; });
  assert.equal(ran, true);
  await currentWrite('k2');
});

test('currentWrite waits for the in-flight write', async () => {
  let done = false;
  void enqueueWrite('k3', async () => { await tick(); done = true; });
  await currentWrite('k3');
  assert.equal(done, true);
});

test('different keys do not wait on each other', async () => {
  let slowDone = false;
  const slow = enqueueWrite('k4', async () => { await tick(); await tick(); slowDone = true; });
  await enqueueWrite('k5', async () => {});
  assert.equal(slowDone, false);
  await slow;
});
