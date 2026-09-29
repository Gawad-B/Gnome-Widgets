import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardStyle, dimLook, glassBlurRadius, glassCardCss, glassHighlight, glassSurfaceAlpha, glassTintColor,
} from '../../src/core/theme-math.ts';

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

test('glassBlurRadius runs from 8 to 40 across the 0..1 range', () => {
  assert.equal(glassBlurRadius(0), 8);
  assert.equal(glassBlurRadius(0.5), 24);
  assert.equal(glassBlurRadius(1), 40);
});

test('glassBlurRadius clamps outside 0..1', () => {
  assert.equal(glassBlurRadius(-1), 8);
  assert.equal(glassBlurRadius(2), 40);
});

test('glassSurfaceAlpha runs from 0.35 down to 0.1 across the 0..1 range', () => {
  assert.equal(glassSurfaceAlpha(0), 0.35);
  assert.equal(glassSurfaceAlpha(0.5), 0.225);
  assert.equal(glassSurfaceAlpha(1), 0.1);
});

test('glassSurfaceAlpha clamps outside 0..1', () => {
  assert.equal(glassSurfaceAlpha(-1), 0.35);
  assert.equal(glassSurfaceAlpha(2), 0.1);
});

test('glassCardCss carries no border or box-shadow, unlike cardStyle', () => {
  const css = glassCardCss('dark', 0);
  assert.match(css, /background-color: rgba\(30, 30, 30, 0\.35\);/);
  assert.doesNotMatch(css, /border/);
  assert.doesNotMatch(css, /box-shadow/);
});

test('glassCardCss gains the same content shadow as cardStyle above 50% translucency', () => {
  assert.match(glassCardCss('dark', 75), /text-shadow: 0 1px 3px rgba\(0, 0, 0, 0\.3\);/);
  assert.match(glassCardCss('dark', 75), /icon-shadow: 0 1px 3px rgba\(0, 0, 0, 0\.3\);/);
});

test('glassTintColor matches glassSurfaceAlpha at the same translucency', () => {
  assert.equal(glassTintColor('dark', 0), 'rgba(30, 30, 30, 0.35)');
  assert.equal(glassTintColor('light', 1), 'rgba(250, 250, 250, 0.1)');
});

test('glassHighlight is stronger in dark mode than light', () => {
  assert.equal(glassHighlight('dark'), 'rgba(255, 255, 255, 0.35)');
  assert.equal(glassHighlight('light'), 'rgba(255, 255, 255, 0.6)');
});
