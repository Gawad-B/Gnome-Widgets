import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultLayout, newId, parseLayout, serializeLayout, splitKnown, type Layout,
} from '../../src/core/layout.ts';

const sequence = (...values: number[]) => () => values.shift() ?? 0.999;

const sample: Layout = {
  version: 1,
  widgets: [
    { id: 'a1b2c3', type: 'clock', size: 'S', col: 0, row: 0, config: { face: 'analog' } },
    { id: 'd4e5f6', type: 'weather', size: 'M', col: 1, row: 0, config: {} },
  ],
};

const invalid = (raw: string) => {
  const result = parseLayout(raw);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.reason, 'invalid');
};

test('empty or blank settings value is reported as empty, not invalid', () => {
  for (const raw of ['', '   ']) {
    const result = parseLayout(raw);
    assert.deepEqual(result.ok ? null : result.reason, 'empty');
  }
});

test('round-trips through serializeLayout', () => {
  assert.deepEqual(parseLayout(serializeLayout(sample)), { ok: true, layout: sample });
});

test('migrates a version-0 bare array and defaults config', () => {
  const result = parseLayout('[{"id":"a","type":"clock","size":"S","col":0,"row":0}]');
  assert.deepEqual(result, {
    ok: true,
    layout: { version: 1, widgets: [{ id: 'a', type: 'clock', size: 'S', col: 0, row: 0, config: {} }] },
  });
});

test('rejects malformed input', () => {
  invalid('{bad');
  invalid('{"version":2,"widgets":[]}');
  invalid('{"version":1}');
  invalid('{"version":1,"widgets":[{"id":"a","type":"clock","size":"XXL","col":0,"row":0}]}');
  invalid('{"version":1,"widgets":[{"id":"a","type":"clock","size":"S","col":-1,"row":0}]}');
  invalid('{"version":1,"widgets":[{"id":"a","type":"clock","size":"S","col":0,"row":0.5}]}');
  invalid('{"version":1,"widgets":[{"type":"clock","size":"S","col":0,"row":0}]}');
  invalid('{"version":1,"widgets":[{"id":"a","type":"clock","size":"S","col":0,"row":0,"config":[]}]}');
  invalid('{"version":1,"widgets":[{"id":"a","type":"clock","size":"S","col":0,"row":0},{"id":"a","type":"clock","size":"S","col":1,"row":0}]}');
});

test('unknown widget types are preserved and split out', () => {
  const result = parseLayout('{"version":1,"widgets":[{"id":"a","type":"future","size":"S","col":0,"row":0,"config":{}}]}');
  assert.ok(result.ok);
  if (!result.ok)
    return;
  const { known, unknown } = splitKnown(result.layout, new Set(['clock']));
  assert.deepEqual(known, []);
  assert.deepEqual(unknown.map(w => w.type), ['future']);
});

test('newId returns 6 hex chars and skips taken ids', () => {
  assert.equal(newId(new Set(), sequence(0)), '000000');
  assert.equal(newId(new Set(['000000']), sequence(0, 0.5)), '800000');
  assert.match(newId(new Set()), /^[0-9a-f]{6}$/);
});

test('defaultLayout only includes registered widget types', () => {
  const clockOnly = defaultLayout(new Set(['clock']), sequence(0.1));
  assert.deepEqual(clockOnly.widgets.map(({ type, size, col, row }) => ({ type, size, col, row })),
    [{ type: 'clock', size: 'S', col: 0, row: 0 }]);

  const both = defaultLayout(new Set(['clock', 'weather']), sequence(0.1, 0.2));
  assert.deepEqual(both.widgets.map(w => [w.type, w.size, w.col, w.row]),
    [['clock', 'S', 0, 0], ['weather', 'M', 1, 0]]);
  assert.notEqual(both.widgets[0]?.id, both.widgets[1]?.id);
});
