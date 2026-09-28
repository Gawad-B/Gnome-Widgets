import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoPlace, cellToPoint, clampToGrid, collides, computeGeometry, fitsInGrid, isFree,
  isSizeName, nearestFree, resizeTarget, snap, spanPixels, type Placement, type SizeName,
} from '../../src/core/grid.ts';

const p = (id: string, size: SizeName, col: number, row: number): Placement => ({ id, size, col, row });
const grid = { cols: 4, rows: 3 };
const geo = computeGeometry(1920, 1048, 16);

test('computeGeometry fits 11×6 cells in a 1920×1048 work area', () => {
  assert.deepEqual(geo, { cols: 11, rows: 6, cell: 150, gap: 16, margin: 32 });
});

test('computeGeometry never returns negative counts', () => {
  const tiny = computeGeometry(40, 40, 16);
  assert.deepEqual([tiny.cols, tiny.rows], [0, 0]);
});

test('cellToPoint and spanPixels convert cells to logical pixels', () => {
  assert.deepEqual(cellToPoint(geo, { col: 2, row: 1 }), { x: 364, y: 198 });
  assert.deepEqual(spanPixels(geo, 'S'), { width: 150, height: 150 });
  assert.deepEqual(spanPixels(geo, 'L'), { width: 316, height: 316 });
  assert.deepEqual(spanPixels(geo, 'XL'), { width: 648, height: 316 });
});

test('isSizeName accepts only known sizes', () => {
  assert.equal(isSizeName('M'), true);
  assert.equal(isSizeName('XXL'), false);
  assert.equal(isSizeName(1), false);
  assert.equal(isSizeName('toString'), false);
});

test('fitsInGrid checks every edge', () => {
  assert.equal(fitsInGrid(grid, 'L', { col: 2, row: 1 }), true);
  assert.equal(fitsInGrid(grid, 'L', { col: 3, row: 0 }), false);
  assert.equal(fitsInGrid(grid, 'L', { col: 0, row: 2 }), false);
  assert.equal(fitsInGrid(grid, 'S', { col: -1, row: 0 }), false);
});

test('collides: touching is fine, overlapping is not', () => {
  assert.equal(collides(p('a', 'S', 0, 0), p('b', 'S', 1, 0)), false);
  assert.equal(collides(p('a', 'M', 0, 0), p('b', 'S', 1, 0)), true);
  assert.equal(collides(p('a', 'L', 0, 0), p('b', 'S', 1, 1)), true);
  assert.equal(collides(p('a', 'S', 2, 0), p('b', 'L', 0, 0)), false);
});

test('isFree respects bounds, collisions and ignoreId', () => {
  const placed = [p('a', 'M', 0, 0)];
  assert.equal(isFree(grid, placed, 'S', { col: 1, row: 0 }), false);
  assert.equal(isFree(grid, placed, 'S', { col: 1, row: 0 }, 'a'), true);
  assert.equal(isFree(grid, placed, 'S', { col: 4, row: 0 }), false);
  assert.equal(isFree(grid, placed, 'S', { col: 2, row: 0 }), true);
});

test('snap rounds to the nearest cell and clamps inside the grid', () => {
  assert.deepEqual(snap(geo, 'S', { x: 434, y: 208 }), { col: 2, row: 1 });
  assert.deepEqual(snap(geo, 'L', { x: 5000, y: 5000 }), { col: 9, row: 4 });
  assert.deepEqual(snap(geo, 'S', { x: -300, y: -300 }), { col: 0, row: 0 });
});

test('autoPlace scans row-major and returns null when full', () => {
  assert.deepEqual(autoPlace(grid, [p('a', 'L', 0, 0)], 'M'), { col: 2, row: 0 });
  assert.deepEqual(autoPlace(grid, [], 'S'), { col: 0, row: 0 });
  assert.equal(autoPlace({ cols: 2, rows: 1 }, [p('a', 'M', 0, 0)], 'S'), null);
});

test('nearestFree picks the smallest Manhattan distance, ties row-major', () => {
  const placed = [p('a', 'S', 0, 0), p('b', 'S', 1, 0)];
  assert.deepEqual(nearestFree(grid, placed, 'S', { col: 0, row: 0 }), { col: 0, row: 1 });
  assert.deepEqual(nearestFree({ cols: 3, rows: 1 }, [p('a', 'S', 1, 0)], 'S', { col: 1, row: 0 }), { col: 0, row: 0 });
  assert.equal(nearestFree({ cols: 1, rows: 1 }, [p('a', 'S', 0, 0)], 'S', { col: 0, row: 0 }), null);
});

test('clampToGrid keeps valid placements and re-places the rest in order', () => {
  const { placed, hidden } = clampToGrid(grid, [p('a', 'S', 0, 0), p('b', 'M', 3, 0)]);
  assert.deepEqual(placed, [p('a', 'S', 0, 0), p('b', 'M', 1, 0)]);
  assert.deepEqual(hidden, []);
});

test('clampToGrid resolves overlaps in favour of the earlier entry', () => {
  const { placed } = clampToGrid(grid, [p('a', 'S', 0, 0), p('b', 'S', 0, 0)]);
  assert.deepEqual(placed, [p('a', 'S', 0, 0), p('b', 'S', 1, 0)]);
});

test('clampToGrid hides what does not fit', () => {
  const { placed, hidden } = clampToGrid({ cols: 2, rows: 1 }, [p('a', 'M', 0, 0), p('b', 'S', 0, 0)]);
  assert.deepEqual(placed, [p('a', 'M', 0, 0)]);
  assert.deepEqual(hidden, ['b']);
});

test('resizeTarget keeps the cell when possible, otherwise moves to the nearest free cell', () => {
  const placed = [p('a', 'S', 0, 0), p('b', 'S', 1, 0)];
  assert.deepEqual(resizeTarget(grid, placed, 'b', 'M'), { col: 1, row: 0 });
  assert.deepEqual(resizeTarget(grid, placed, 'a', 'M'), { col: 0, row: 1 });
  assert.equal(resizeTarget({ cols: 2, rows: 1 }, placed, 'a', 'L'), null);
  assert.equal(resizeTarget(grid, placed, 'missing', 'S'), null);
});
