import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
  applyOp, applyOps, isoWithOffset, newTaskId, parseTaskFile, serializeTaskFile, TaskFileError,
  type Task, type TaskOp,
} from '../core/tasks.ts';
import { ensureDirectory, isCancelled, isNotFound, loadText, replaceText } from './gio-file.ts';
import { Service, type Scheduler } from './service.ts';
import { backupCorruptTasksFile } from './task-file-backup.ts';
import { currentWrite, enqueueWrite } from './write-chain.ts';

const SAVE_DEBOUNCE_MS = 500;

function dataDir(): Gio.File {
  return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'desk-widgets']));
}

// The Reminders to-do list, persisted at GLib.get_user_data_dir()/desk-widgets/tasks.json.
// Loads asynchronously; mutations made before the load finishes are queued and replayed on top
// of what it loaded. Once loaded, mutations are published in memory at once while the write to
// disk is debounced 500 ms, serialized per file, and replaces the file atomically. A file that
// fails to parse on load is backed up alongside itself before the list starts empty; if it
// can't be backed up, the store fails instead of ever overwriting it.
export class TaskStore extends Service<readonly Task[]> {
  private readonly _scheduler: Scheduler;
  private _tasks: Task[] = [];
  private _cancellable: Gio.Cancellable | null = null;
  private _saveTimer: number | null = null;
  private _monitor: Gio.FileMonitor | null = null;
  // The exact text last written or loaded, so an external-edit notification that only echoes a
  // write we just made ourselves (and so already reflects) is told apart from a real change.
  private _lastKnownText: string | null = null;
  // False from the moment start() begins until this run's own load (not a stale one left over
  // from before a restart) has settled. A mutation that arrives before then is queued rather
  // than applied, so it can never be computed against data older than what's on disk, or
  // trigger a save that overwrites the file with less than what's really there.
  private _loaded = false;
  private _pendingOps: TaskOp[] = [];
  // Sits between the debounce timer firing and its write actually finishing on disk. An
  // external-edit notification that arrives in that window is deferred rather than acted on
  // immediately (see _reload), since the file it would read may not reflect our own still-
  // in-flight edit yet.
  private _writeBusy = false;
  private _reloadDeferred = false;

  constructor(scheduler: Scheduler) {
    super(scheduler);
    this._scheduler = scheduler;
  }

  static filePath(): string {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'desk-widgets', 'tasks.json']);
  }

  add(title: string): void {
    this._apply({ kind: 'add', title, id: newTaskId(Math.random), created: isoWithOffset(new Date()) });
  }

  toggle(id: string): void {
    this._apply({ kind: 'toggle', id });
  }

  remove(id: string): void {
    this._apply({ kind: 'remove', id });
  }

  move(id: string, toIndex: number): void {
    this._apply({ kind: 'move', id, toIndex });
  }

  clearCompleted(): void {
    this._apply({ kind: 'clearCompleted' });
  }

  protected start(): void {
    this._loaded = false;
    this._reloadDeferred = false;
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    void this._load(cancellable);
  }

  protected stop(): void {
    this._cancellable?.cancel();
    this._cancellable = null;
    // Anything arriving while stopped is queued for the next load rather than saved blind.
    this._loaded = false;
    if (this._saveTimer !== null) {
      this._scheduler.cancel(this._saveTimer);
      this._saveTimer = null;
      // Fire-and-forget, with its own cancellable that this stop() never touches (see
      // _writeNow), so the last edit still reaches disk after disable().
      void this._writeNow();
    }
    if (this._monitor) {
      this._monitor.cancel();
      this._monitor.disconnectObject(this);
      this._monitor = null;
    }
  }

  private _file(): Gio.File {
    return Gio.File.new_for_path(TaskStore.filePath());
  }

  private _apply(op: TaskOp): void {
    if (!this._loaded) {
      this._pendingOps.push(op);
      return;
    }
    this._tasks = applyOp(this._tasks, op);
    // Schedule first: publish() can synchronously drive the last listener away (stopping the
    // store), and stop() then flushes this pending save instead of leaving a timer behind.
    this._scheduleSave();
    this.publish(this._tasks);
  }

  // Marks this run's load as settled, replaying whatever mutations arrived while it was still
  // in flight on top of the list it produced. Only reached on a load that actually succeeded in
  // producing a list (parsed cleanly, the file was simply missing, or a corrupt file was
  // safely backed up) - never after fail(), so a mutation queued during a load that's still
  // going to retry keeps waiting for a run that really has something to apply it to.
  private _finishLoad(): void {
    const ops = this._pendingOps;
    this._pendingOps = [];
    this._loaded = true;
    if (ops.length > 0) {
      this._tasks = applyOps(this._tasks, ops);
      this._scheduleSave();
    }
    this.publish(this._tasks);
  }

  private async _load(cancellable: Gio.Cancellable): Promise<void> {
    const path = TaskStore.filePath();
    // A previous instance's final save (fired from its stop(), possibly still in flight) must
    // land before this read, or this load can see the file as it was before that edit and then
    // treat that as the truth.
    await currentWrite(path);
    if (!this.running || this._cancellable !== cancellable)
      return;

    const file = this._file();
    let text: string | null;
    try {
      text = await loadText(file, cancellable);
    } catch (e) {
      if (!this.running || this._cancellable !== cancellable || isCancelled(e))
        return;
      if (!isNotFound(e)) {
        this.fail(e);
        return;
      }
      text = null;
    }
    if (!this.running || this._cancellable !== cancellable)
      return;

    if (text === null) {
      this._tasks = [];
      this._lastKnownText = null;
    } else {
      try {
        this._tasks = parseTaskFile(text).tasks;
        this._lastKnownText = text;
      } catch (e) {
        if (!(e instanceof TaskFileError))
          throw e;
        const backedUp = await backupCorruptTasksFile(file, cancellable);
        if (!this.running || this._cancellable !== cancellable)
          return;
        if (!backedUp) {
          this.fail(new Error('tasks.json is unreadable and could not be backed up'));
          return;
        }
        this._tasks = [];
        this._lastKnownText = null;
      }
    }

    this._finishLoad();
    // _finishLoad() publishes, which can stop this run from inside a listener.
    if (!this.running || this._cancellable !== cancellable)
      return;
    this._watch(file, cancellable);
  }

  private _watch(file: Gio.File, cancellable: Gio.Cancellable): void {
    let monitor: Gio.FileMonitor;
    try {
      monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, cancellable);
    } catch (e) {
      console.error('Desk Widgets: failed to watch tasks.json for external edits', e);
      return;
    }
    monitor.connectObject('changed', (
      _monitor: Gio.FileMonitor, _file: Gio.File, _other: Gio.File | null, eventType: Gio.FileMonitorEvent,
    ) => {
      if (eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        return;
      void this._reload(cancellable);
    }, this);
    this._monitor = monitor;
  }

  private async _reload(cancellable: Gio.Cancellable): Promise<void> {
    if (!this.running || this._cancellable !== cancellable)
      return;
    // A save that's scheduled or actually landing right now hasn't necessarily reached disk
    // yet: reading the file this instant could see the pre-edit content and mistake it for an
    // external change, publishing over (and so discarding) the in-memory edit that's about to
    // be saved. Wait for the debounce and the write it triggers to both settle, then try again.
    if (this._saveTimer !== null || this._writeBusy) {
      this._reloadDeferred = true;
      return;
    }
    const file = this._file();
    try {
      const text = await loadText(file, cancellable);
      if (!this.running || this._cancellable !== cancellable)
        return;
      // A save may have been scheduled or started while this read was in flight.
      if (this._saveTimer !== null || this._writeBusy) {
        this._reloadDeferred = true;
        return;
      }
      if (text === this._lastKnownText)
        return;
      let tasks: Task[];
      try {
        tasks = parseTaskFile(text).tasks;
      } catch (e) {
        if (!(e instanceof TaskFileError))
          throw e;
        // Unlike the initial load, a reload never backs anything up or resets the list: the
        // in-memory tasks (and whatever's still pending to be saved) are the only copy that
        // still makes sense, and an external edit that merely broke the file's syntax is very
        // likely a stray keystroke mid-hand-edit rather than real damage worth reacting to.
        console.error('Desk Widgets: ignoring an external edit that left tasks.json unreadable', e);
        return;
      }
      this._tasks = tasks;
      this._lastKnownText = text;
      this.publish(this._tasks);
    } catch (e) {
      // A file that's momentarily missing or unreadable mid-external-edit is left for the next
      // change notification; this reload just does nothing rather than failing the service.
      if (!this.running || this._cancellable !== cancellable || isCancelled(e))
        return;
    }
  }

  private _scheduleSave(): void {
    if (this._saveTimer !== null)
      this._scheduler.cancel(this._saveTimer);
    this._saveTimer = this._scheduler.schedule(SAVE_DEBOUNCE_MS, () => {
      this._saveTimer = null;
      void this._writeNow();
    });
  }

  // Never tied to the service's own _cancellable (stop() cancels that one): a save must land
  // on disk even when it's still in flight, or was just kicked off, at the moment disable()
  // runs. Chained through the module-level write queue for this path, so overlapping saves
  // (this instance's own, or a just-replaced instance's final flush) can never finish out of
  // order and leave a stale write as the last word on disk.
  private _writeNow(): Promise<void> {
    const path = TaskStore.filePath();
    return enqueueWrite(path, async () => {
      this._writeBusy = true;
      try {
        const cancellable = new Gio.Cancellable();
        // Read at the moment this write actually starts, not when it was scheduled: by the
        // time an earlier queued write finishes and this one's turn comes up, _tasks may have
        // moved on further still, and that newer state is what belongs on disk.
        const text = serializeTaskFile(this._tasks);
        try {
          await ensureDirectory(dataDir(), cancellable);
          await replaceText(this._file(), text, cancellable);
          this._lastKnownText = text;
        } catch (e) {
          if (!isCancelled(e))
            console.error('Desk Widgets: failed to save tasks.json', e);
        }
      } finally {
        this._writeBusy = false;
        this._onWriteSettled();
      }
    });
  }

  private _onWriteSettled(): void {
    if (!this._reloadDeferred || !this.running || !this._cancellable)
      return;
    this._reloadDeferred = false;
    void this._reload(this._cancellable);
  }
}
