import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artCacheName, formatMediaTime, pickActivePlayer, pruneList, type PlayerState,
} from '../../src/core/media.ts';

test('formatMediaTime formats seconds, minutes and hours', () => {
  assert.equal(formatMediaTime(7), '0:07');
  assert.equal(formatMediaTime(225), '3:45');
  assert.equal(formatMediaTime(3723), '1:02:03');
  assert.equal(formatMediaTime(0), '0:00');
  assert.equal(formatMediaTime(59), '0:59');
  assert.equal(formatMediaTime(3600), '1:00:00');
});

test('formatMediaTime is empty for negative or non-finite input', () => {
  assert.equal(formatMediaTime(-1), '');
  assert.equal(formatMediaTime(NaN), '');
  assert.equal(formatMediaTime(Infinity), '');
});

const p = (id: string, status: PlayerState['status'], lastPlayingAt: number): PlayerState =>
  ({ id, status, lastPlayingAt });

test('pickActivePlayer is null for an empty list', () => {
  assert.equal(pickActivePlayer([]), null);
});

test('pickActivePlayer picks the highest lastPlayingAt among those that have one', () => {
  const players = [p('a', 'Paused', 100), p('b', 'Playing', 300), p('c', 'Paused', 200)];
  assert.equal(pickActivePlayer(players), 'b');
});

test('pickActivePlayer falls back to the first Playing player when none has ever played', () => {
  const players = [p('a', 'Paused', 0), p('b', 'Playing', 0), p('c', 'Stopped', 0)];
  assert.equal(pickActivePlayer(players), 'b');
});

test('pickActivePlayer falls back to the first player when nothing is playing or has played', () => {
  const players = [p('a', 'Stopped', 0), p('b', 'Paused', 0)];
  assert.equal(pickActivePlayer(players), 'a');
});

test('artCacheName matches known SHA-1 vectors', () => {
  assert.equal(artCacheName('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(artCacheName(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(
    artCacheName('https://example.com/art/♪.jpg'),
    '92462ff9b47cc7c4d00f609451121a4dab0b8b7d',
  );
});

test('pruneList returns everything past the newest `keep` by mtime', () => {
  const files = [{ mtime: 5 }, { mtime: 1 }, { mtime: 3 }, { mtime: 2 }, { mtime: 4 }];
  assert.deepEqual(pruneList(files, 3), [{ mtime: 2 }, { mtime: 1 }]);
  assert.deepEqual(pruneList(files, 10), []);
  assert.deepEqual(pruneList(files, 0), [{ mtime: 5 }, { mtime: 4 }, { mtime: 3 }, { mtime: 2 }, { mtime: 1 }]);
});
