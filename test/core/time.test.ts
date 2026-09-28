import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNext } from '../../src/core/time.ts';

test('msUntilNext waits for the next boundary, never zero', () => {
  assert.equal(msUntilNext(0, 60_000), 60_000);
  assert.equal(msUntilNext(59_999, 60_000), 1);
  assert.equal(msUntilNext(61_500, 60_000), 58_500);
  assert.equal(msUntilNext(1_500, 1_000), 500);
});
