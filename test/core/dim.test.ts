import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDimMode, shouldDim } from '../../src/core/dim.ts';

test('automatic dims only while covered', () => {
  assert.equal(shouldDim('automatic', true, false), true);
  assert.equal(shouldDim('automatic', false, false), false);
});

test('always and never ignore coverage', () => {
  assert.equal(shouldDim('always', false, false), true);
  assert.equal(shouldDim('never', true, false), false);
});

test('edit mode is never dimmed', () => {
  assert.equal(shouldDim('always', true, true), false);
});

test('isDimMode validates settings strings', () => {
  assert.equal(isDimMode('never'), true);
  assert.equal(isDimMode('sometimes'), false);
});
