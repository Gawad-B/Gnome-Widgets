import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardStyle, dimLook } from '../../src/core/theme-math.ts';

test('solid dark card: full surface, no content shadow', () => {
  const style = cardStyle('dark', 0);
  assert.match(style.css, /background-color: rgba\(30, 30, 30, 0\.85\);/);
  assert.match(style.css, /border: 1px solid rgba\(255, 255, 255, 0\.12\);/);
  assert.match(style.css, /box-shadow: 0 2px 12px 0 rgba\(0, 0, 0, 0\.25\);/);
  assert.doesNotMatch(style.css, /text-shadow/);
  assert.equal(style.outlineTracks, false);
});

test('default 30% keeps a mostly solid card', () => {
  assert.match(cardStyle('dark', 30).css, /background-color: rgba\(30, 30, 30, 0\.595\);/);
});

test('half translucency switches tracks to outlines but adds no shadow yet', () => {
  const style = cardStyle('dark', 50);
  assert.doesNotMatch(style.css, /text-shadow/);
  assert.equal(style.outlineTracks, true);
});

test('content shadow grows above 50%', () => {
  assert.match(cardStyle('dark', 75).css, /text-shadow: 0 1px 3px rgba\(0, 0, 0, 0\.3\);/);
  assert.match(cardStyle('dark', 75).css, /icon-shadow: 0 1px 3px rgba\(0, 0, 0, 0\.3\);/);
});

test('clear light card: no surface, light glow behind dark text', () => {
  const style = cardStyle('light', 100);
  assert.match(style.css, /background-color: rgba\(250, 250, 250, 0\);/);
  assert.match(style.css, /border: 1px solid rgba\(0, 0, 0, 0\);/);
  assert.match(style.css, /text-shadow: 0 1px 3px rgba\(255, 255, 255, 0\.6\);/);
});

test('translucency is clamped to 0..100', () => {
  assert.deepEqual(cardStyle('dark', 150), cardStyle('dark', 100));
  assert.deepEqual(cardStyle('dark', -10), cardStyle('dark', 0));
});

test('dimLook desaturates only while there is a card to desaturate', () => {
  assert.deepEqual(dimLook(49), { opacity: 166, desaturate: true });
  assert.deepEqual(dimLook(50), { opacity: 166, desaturate: false });
});
