// The Reminders to-do list: pure data operations and (de)serialization for tasks.json. No
// gi:// imports, so it runs under Node in tests; loading, saving and file-watching around it
// live in services/task-store.ts.

export interface Task {
  id: string;
  title: string;
  done: boolean;
  created: string;  // ISO 8601 with offset, e.g. "2026-09-26T10:15:00+03:00"
}

export interface TaskFile {
  version: 1;
  tasks: Task[];
}

export class TaskFileError extends Error {}

const TASK_FILE_VERSION = 1;
const MAX_TITLE_LENGTH = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Returns null for a task that should be silently dropped rather than making the whole file
// unreadable: an empty id is a value a hand-edit can easily produce (an emptied field, a
// half-finished line) and doesn't tell us anything is structurally wrong with the rest of the
// file, unlike a field of the wrong type entirely.
function parseTask(value: unknown, index: number): Task | null {
  if (!isRecord(value))
    throw new TaskFileError(`tasks[${index}] is not an object`);
  const { id, title, done, created } = value;
  if (typeof id !== 'string')
    throw new TaskFileError(`tasks[${index}].id must be a string`);
  if (typeof title !== 'string')
    throw new TaskFileError(`tasks[${index}].title must be a string`);
  if (typeof done !== 'boolean')
    throw new TaskFileError(`tasks[${index}].done must be a boolean`);
  if (created !== undefined && typeof created !== 'string')
    throw new TaskFileError(`tasks[${index}].created must be a string`);
  if (id === '')
    return null;
  return { id, title, done, created: created ?? '' };
}

// Throws TaskFileError on anything malformed: not JSON, the wrong version, a `tasks` that
// isn't an array, or a task with a field of the wrong type. When ids repeat, the first task
// with that id wins and later duplicates are dropped; a task whose id is an empty string is
// dropped outright rather than rejecting the file.
export function parseTaskFile(text: string): TaskFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new TaskFileError(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(data) || data.version !== TASK_FILE_VERSION || !Array.isArray(data.tasks))
    throw new TaskFileError(`expected {"version": ${TASK_FILE_VERSION}, "tasks": [...]}`);

  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (const [index, value] of data.tasks.entries()) {
    const task = parseTask(value, index);
    if (task === null || ids.has(task.id))
      continue;
    ids.add(task.id);
    tasks.push(task);
  }
  return { version: TASK_FILE_VERSION, tasks };
}

export function serializeTaskFile(tasks: readonly Task[]): string {
  return `${JSON.stringify({ version: TASK_FILE_VERSION, tasks }, null, 2)}\n`;
}

// Trims the title and caps it at 200 characters; an empty (post-trim) title leaves the list
// unchanged. The new task is appended at the end.
export function addTask(tasks: readonly Task[], title: string, id: string, created: string): Task[] {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (trimmed === '')
    return [...tasks];
  return [...tasks, { id, title: trimmed, done: false, created }];
}

export function toggleTask(tasks: readonly Task[], id: string): Task[] {
  return tasks.map(t => (t.id === id ? { ...t, done: !t.done } : t));
}

export function removeTask(tasks: readonly Task[], id: string): Task[] {
  return tasks.filter(t => t.id !== id);
}

// Moves the task with `id` to `toIndex` among the remaining tasks, clamped to a valid index.
// An unknown id leaves the list unchanged.
export function moveTask(tasks: readonly Task[], id: string, toIndex: number): Task[] {
  const from = tasks.findIndex(t => t.id === id);
  if (from === -1)
    return [...tasks];
  const rest = tasks.filter(t => t.id !== id);
  const clamped = Math.max(0, Math.min(toIndex, rest.length));
  const moved = tasks[from]!;
  rest.splice(clamped, 0, moved);
  return rest;
}

export function clearCompleted(tasks: readonly Task[]): Task[] {
  return tasks.filter(t => !t.done);
}

// Tasks that aren't done, in file order.
export function openTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(t => !t.done);
}

// "2026-09-26T10:15:00+03:00" — local wall-clock fields with a numeric UTC offset, no
// milliseconds.
export function isoWithOffset(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absMinutes / 60));
  const offsetMins = pad(absMinutes % 60);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date}T${time}${sign}${offsetHours}:${offsetMins}`;
}

// Six lowercase hex characters, e.g. "9f8e7d".
export function newTaskId(random: () => number): string {
  return Math.floor(random() * 0x1000000).toString(16).padStart(6, '0');
}

// A queueable form of each mutation above, so a caller that isn't ready to apply one yet (the
// list it would apply to hasn't loaded) can hold onto it and replay it later, in order, once
// it is.
export type TaskOp =
  | { kind: 'add'; title: string; id: string; created: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'move'; id: string; toIndex: number }
  | { kind: 'clearCompleted' };

export function applyOp(tasks: readonly Task[], op: TaskOp): Task[] {
  switch (op.kind) {
  case 'add': return addTask(tasks, op.title, op.id, op.created);
  case 'toggle': return toggleTask(tasks, op.id);
  case 'remove': return removeTask(tasks, op.id);
  case 'move': return moveTask(tasks, op.id, op.toIndex);
  case 'clearCompleted': return clearCompleted(tasks);
  }
}

// Replays a queue of ops onto `tasks` in order. An empty queue returns the list unchanged.
export function applyOps(tasks: readonly Task[], ops: readonly TaskOp[]): Task[] {
  let result: Task[] = [...tasks];
  for (const op of ops)
    result = applyOp(result, op);
  return result;
}
