import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTask, applyOp, applyOps, clearCompleted, moveTask, newTaskId, openTasks, parseTaskFile,
  removeTask, serializeTaskFile, TaskFileError, toggleTask, type Task, type TaskFile, type TaskOp,
} from '../../src/core/tasks.ts';

const sequence = (...values: number[]) => () => values.shift() ?? 0.999;

const t = (id: string, title: string, done = false, created = ''): Task =>
  ({ id, title, done, created });

const sample: TaskFile = {
  version: 1,
  tasks: [
    t('a1b2c3', 'Buy milk', false, '2026-09-26T10:15:00+03:00'),
    t('d4e5f6', 'Walk the dog', true, '2026-09-25T08:00:00+03:00'),
  ],
};

test('addTask trims, caps at 200 chars and appends at the end', () => {
  const tasks = [t('a', 'first')];
  const result = addTask(tasks, '  second  ', 'b', '2026-01-01T00:00:00+00:00');
  assert.deepEqual(result, [t('a', 'first'), t('b', 'second', false, '2026-01-01T00:00:00+00:00')]);

  const long = 'x'.repeat(250);
  const capped = addTask([], long, 'c', '');
  assert.equal(capped[0]!.title.length, 200);
  assert.equal(capped[0]!.title, 'x'.repeat(200));
});

test('addTask leaves the list unchanged for an empty (post-trim) title', () => {
  const tasks = [t('a', 'first')];
  assert.deepEqual(addTask(tasks, '   ', 'b', ''), tasks);
  assert.deepEqual(addTask(tasks, '', 'b', ''), tasks);
});

test('toggleTask flips only the matching task', () => {
  const tasks = [t('a', 'x', false), t('b', 'y', false)];
  assert.deepEqual(toggleTask(tasks, 'a'), [t('a', 'x', true), t('b', 'y', false)]);
  assert.deepEqual(toggleTask(tasks, 'missing'), tasks);
});

test('removeTask drops the matching task and leaves others untouched', () => {
  const tasks = [t('a', 'x'), t('b', 'y'), t('c', 'z')];
  assert.deepEqual(removeTask(tasks, 'b'), [t('a', 'x'), t('c', 'z')]);
  assert.deepEqual(removeTask(tasks, 'missing'), tasks);
});

test('moveTask reorders and clamps toIndex to a valid position', () => {
  const tasks = [t('a', 'A'), t('b', 'B'), t('c', 'C')];
  assert.deepEqual(moveTask(tasks, 'c', 0).map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(moveTask(tasks, 'a', 2).map(x => x.id), ['b', 'c', 'a']);
  // Out-of-range indices clamp rather than throw or drop the task.
  assert.deepEqual(moveTask(tasks, 'a', 99).map(x => x.id), ['b', 'c', 'a']);
  assert.deepEqual(moveTask(tasks, 'c', -5).map(x => x.id), ['c', 'a', 'b']);
  // An unknown id leaves the list unchanged.
  assert.deepEqual(moveTask(tasks, 'missing', 1), tasks);
});

test('clearCompleted keeps only the open tasks', () => {
  const tasks = [t('a', 'A', false), t('b', 'B', true), t('c', 'C', true)];
  assert.deepEqual(clearCompleted(tasks), [t('a', 'A', false)]);
});

test('openTasks keeps only the open tasks in file order', () => {
  const tasks = [t('a', 'A', true), t('b', 'B', false), t('c', 'C', false)];
  assert.deepEqual(openTasks(tasks), [t('b', 'B', false), t('c', 'C', false)]);
});

test('round-trips through serializeTaskFile', () => {
  assert.deepEqual(parseTaskFile(serializeTaskFile(sample.tasks)), sample);
});

test('serializeTaskFile is 2-space indented JSON with a trailing newline', () => {
  const text = serializeTaskFile([t('a', 'x')]);
  assert.ok(text.endsWith('\n'));
  assert.ok(text.includes('\n  "version": 1,\n'));
});

test('rejects malformed input', () => {
  const bad = (raw: string) => assert.throws(() => parseTaskFile(raw), TaskFileError);
  bad('{not json');
  bad('{"version":2,"tasks":[]}');
  bad('{"version":1}');
  bad('{"version":1,"tasks":{}}');
  bad('{"version":1,"tasks":[{"title":"x","done":false}]}');
  bad('{"version":1,"tasks":[{"id":"a","done":false}]}');
  bad('{"version":1,"tasks":[{"id":"a","title":"x"}]}');
  bad('{"version":1,"tasks":[{"id":"a","title":"x","done":"no"}]}');
  bad('{"version":1,"tasks":[{"id":"a","title":"x","done":false,"created":5}]}');
  // A task entry that isn't an object at all (a bare number, string or array) is still a
  // structural problem with the file, unlike an empty id (see below).
  bad('{"version":1,"tasks":[5]}');
  bad('{"version":1,"tasks":["x"]}');
  bad('{"version":1,"tasks":[[]]}');
});

test('a task with an empty id is skipped rather than rejecting the whole file', () => {
  const result = parseTaskFile(
    '{"version":1,"tasks":['
    + '{"id":"","title":"orphaned","done":false},'
    + '{"id":"a","title":"kept","done":true}'
    + ']}',
  );
  assert.deepEqual(result.tasks, [t('a', 'kept', true, '')]);
});

test('defaults a missing created field to an empty string', () => {
  const result = parseTaskFile('{"version":1,"tasks":[{"id":"a","title":"x","done":false}]}');
  assert.deepEqual(result.tasks, [t('a', 'x', false, '')]);
});

test('drops unknown fields', () => {
  const result = parseTaskFile('{"version":1,"tasks":[{"id":"a","title":"x","done":false,"extra":true}]}');
  assert.deepEqual(result.tasks, [t('a', 'x', false, '')]);
});

test('when ids repeat, the first task with that id wins', () => {
  const result = parseTaskFile(
    '{"version":1,"tasks":['
    + '{"id":"a","title":"first","done":false},'
    + '{"id":"a","title":"second","done":true}'
    + ']}',
  );
  assert.deepEqual(result.tasks, [t('a', 'first', false, '')]);
});

test('newTaskId returns 6 lowercase hex characters from the injected random', () => {
  assert.equal(newTaskId(sequence(0)), '000000');
  assert.equal(newTaskId(sequence(0.5)), '800000');
  assert.match(newTaskId(Math.random), /^[0-9a-f]{6}$/);
});

test('applyOp dispatches each op kind to its matching pure operation', () => {
  const tasks = [t('a', 'A', false), t('b', 'B', true)];
  const cases: Array<[TaskOp, Task[]]> = [
    [{ kind: 'add', title: 'C', id: 'c', created: '2026-01-01T00:00:00+00:00' },
      addTask(tasks, 'C', 'c', '2026-01-01T00:00:00+00:00')],
    [{ kind: 'toggle', id: 'a' }, toggleTask(tasks, 'a')],
    [{ kind: 'remove', id: 'b' }, removeTask(tasks, 'b')],
    [{ kind: 'move', id: 'b', toIndex: 0 }, moveTask(tasks, 'b', 0)],
    [{ kind: 'clearCompleted' }, clearCompleted(tasks)],
  ];
  for (const [op, expected] of cases)
    assert.deepEqual(applyOp(tasks, op), expected);
});

test('applyOps replays a queue of ops in order onto a base list', () => {
  const result = applyOps([], [
    { kind: 'add', title: 'first', id: 'a', created: '' },
    { kind: 'add', title: 'second', id: 'b', created: '' },
    { kind: 'toggle', id: 'a' },
    { kind: 'remove', id: 'b' },
  ]);
  assert.deepEqual(result, [t('a', 'first', true, '')]);
});

test('applyOps with an empty queue returns the base list unchanged', () => {
  const tasks = [t('a', 'A')];
  assert.deepEqual(applyOps(tasks, []), tasks);
});
