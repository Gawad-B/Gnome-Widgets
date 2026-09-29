import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// St parses a negative length in the `margin`/`padding` shorthands as an unsigned value
// (~2^32px). One such actor inflates the widget layer's paint volume past what an offscreen
// framebuffer can hold, and the Dimmer's layer-wide effect then paints nothing at all.
test('stylesheet has no negative margin or padding lengths', () => {
  const css = readFileSync(new URL('../../stylesheet.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [...css.matchAll(/\b(?:margin|padding)(?:-[a-z]+)?\s*:[^;}]*/g)]
    .map(m => m[0].trim())
    .filter(decl => /(^|[\s:])-\d/.test(decl));
  assert.deepEqual(offenders, []);
});
