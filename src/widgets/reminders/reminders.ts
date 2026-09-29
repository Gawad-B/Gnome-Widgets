import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { openTasks, type Task } from '../../core/tasks.ts';
import type { Snapshot } from '../../services/service.ts';
import type { TaskStore } from '../../services/task-store.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { buildStatusLabel } from '../common/message.ts';
import { TaskEntryController } from './task-entry.ts';

// M's content area is 118px (a 150px card minus desk-card-content's 16px padding each side) and
// L's is 284px (a 316px card - two 150px cells plus a 16px grid gap - minus the same padding).
// M keeps 3 rows normally, dropping to 1 while the entry is open (see _rowLimit() below for why
// it's 1, not 2), which the widget re-evaluates via TaskEntryController's onOpenChange callback;
// L has enough room for all 8 with the entry open too, so it never needs to shrink.
const ROW_LIMIT = { M: 3, L: 8 } as const;
const HOLD_MS = 1500;

interface TaskRow { root: St.BoxLayout; check: St.Button; checkIcon: St.Icon; title: St.Label }

function makeRow(task: Task, onToggle: () => void): TaskRow {
  const root = new St.BoxLayout({ style_class: 'desk-rem-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
  const checkIcon = new St.Icon({ icon_name: 'object-select-symbolic', style_class: 'desk-rem-check-icon', visible: false });
  const check = new St.Button({ style_class: 'desk-rem-check', child: checkIcon, can_focus: true });
  check.connect('clicked', onToggle);
  root.add_child(check);
  const title = new St.Label({ style_class: 'desk-rem-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
  title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
  root.add_child(title);
  const row: TaskRow = { root, check, checkIcon, title };
  applyRowState(row, task);
  return row;
}

function applyRowState(row: TaskRow, task: Task): void {
  if (task.done) {
    row.check.add_style_class_name('desk-rem-check-done');
    row.checkIcon.show();
    row.title.add_style_class_name('desk-rem-title-done');
    row.title.clutter_text.set_markup(`<s>${GLib.markup_escape_text(task.title, -1)}</s>`);
  } else {
    row.check.remove_style_class_name('desk-rem-check-done');
    row.checkIcon.hide();
    row.title.remove_style_class_name('desk-rem-title-done');
    row.title.clutter_text.use_markup = false;
    row.title.text = task.title;
  }
}

// S: a large open count, "Reminders" underneath, then the next open task's title or "All done".
// M/L: a header (title, open count, ＋), up to 3 (M, 2 while the entry is open) or 8 (L) rows -
// open tasks first, then done - each with a checkbox and title (done: dimmed and struck through
// via Pango markup). A task
// just checked off stays in place for HOLD_MS before the list re-sorts around it, tracked per id
// so a second task checked off mid-hold gets its own independent timer. Rows rebuild only when
// the visible (id, done) list (in display order) actually changes; the header's open count and
// S's own labels update in place on every snapshot regardless.
class RemindersWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private readonly _service: TaskStore;
  private readonly _entryCtl: TaskEntryController;
  private _mode: string | null = null;

  private _countLabel: St.Label | null = null;
  private _nextLabel: St.Label | null = null;
  private _headerCount: St.Label | null = null;
  private _entryHolder: St.BoxLayout | null = null;
  private _rowsBox: St.BoxLayout | null = null;
  private readonly _rows = new Map<string, TaskRow>();

  private _lastTasks: readonly Task[] | null = null;
  private _lastDoneById: Map<string, boolean> | null = null;
  private _displayOrder: string[] = [];
  private _lastKey: string | null = null;
  private readonly _heldIds = new Set<string>();
  private readonly _holdTimers = new Map<string, number>();

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-rem desk-rem-${ctx.size}`,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;
    this._service = ctx.hub.tasks();
    this._entryCtl = new TaskEntryController(box, text => this._service.add(text), () => {
      // The entry opening or closing changes how many rows fit (see ROW_LIMIT above); re-derive
      // the visible list against the same task snapshot rather than waiting for the next publish.
      if (this._lastTasks)
        this._applySnapshot(this._lastTasks);
    });
    ctx.scope.onCleanup(() => {
      this._entryCtl.close();
      this._clearHolds();
    });
    ctx.scope.watch(this._service, snapshot => this._render(snapshot));
  }

  private _render(snapshot: Snapshot<readonly Task[]>): void {
    if (snapshot.state === 'loading') {
      this._show('loading', () => this._box.add_child(buildStatusLabel('…')));
      return;
    }
    if (snapshot.state !== 'ready' || !snapshot.value) {
      this._show('error', () => this._box.add_child(buildStatusLabel('Reminders unavailable')));
      return;
    }
    this._show('ready', () => (this._size === 'S' ? this._buildS() : this._buildML()));
    this._applySnapshot(snapshot.value);
  }

  private _show(mode: string, build: () => void): void {
    if (this._mode === mode)
      return;
    // Only on an actual mode change: clearing every hold on each identical-mode snapshot would
    // cancel the 1.5s "stay in place" window before it ever gets a chance to elapse, and closing
    // the entry controller here (rather than leaving it to ctx.scope.onCleanup alone) means a
    // loading/error snapshot arriving while the entry is open - which destroys _entryHolder along
    // with the rest of the box below - can never strand its modal grab.
    this._clearHolds();
    this._entryCtl.close();
    this._box.destroy_all_children();
    this._countLabel = null; this._nextLabel = null; this._headerCount = null;
    this._entryHolder = null; this._rowsBox = null;
    this._rows.clear();
    this._lastKey = null;
    this._displayOrder = [];
    this._mode = mode;
    build();
  }

  private _buildS(): void {
    const col = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-rem-s-col',
      x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true,
    });
    this._countLabel = new St.Label({ style_class: 'desk-rem-count', x_align: Clutter.ActorAlign.CENTER });
    col.add_child(this._countLabel);
    col.add_child(new St.Label({ text: 'Reminders', style_class: 'desk-rem-label', x_align: Clutter.ActorAlign.CENTER }));
    this._nextLabel = new St.Label({ style_class: 'desk-rem-next', x_align: Clutter.ActorAlign.CENTER });
    this._nextLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    col.add_child(this._nextLabel);
    this._box.add_child(col);
  }

  private _buildML(): void {
    const header = new St.BoxLayout({ style_class: 'desk-rem-header', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    header.add_child(new St.Label({ text: 'Reminders', style_class: 'desk-rem-header-title' }));
    this._headerCount = new St.Label({ style_class: 'desk-rem-header-count', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    header.add_child(this._headerCount);
    const add = new St.Button({ style_class: 'desk-rem-add', label: '＋', can_focus: true });
    add.connect('clicked', () => {
      if (this._entryHolder)
        this._entryCtl.open(this._entryHolder);
    });
    header.add_child(add);
    this._box.add_child(header);

    this._entryHolder = new St.BoxLayout({ style_class: 'desk-rem-entry-row', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    this._box.add_child(this._entryHolder);

    this._rowsBox = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-rem-list', x_expand: true });
    this._box.add_child(this._rowsBox);
  }

  private _applySnapshot(tasks: readonly Task[]): void {
    if (this._lastDoneById) {
      for (const task of tasks) {
        if (task.done && this._lastDoneById.get(task.id) === false && !this._heldIds.has(task.id))
          this._holdTask(task.id);
      }
    }
    this._lastDoneById = new Map(tasks.map(t => [t.id, t.done]));
    this._lastTasks = tasks;

    if (this._size === 'S') {
      this._updateS(tasks);
      return;
    }
    this._updateHeader(tasks);

    const order = this._computeDisplayOrder(tasks);
    this._displayOrder = order;
    const byId = new Map(tasks.map(t => [t.id, t]));
    const visible = order.slice(0, this._rowLimit()).map(id => byId.get(id)).filter((t): t is Task => t !== undefined);
    const key = visible.map(t => `${t.id}:${t.done}`).join(',');
    if (key === this._lastKey) {
      // The visible (id, done) sequence hasn't changed, but a task's title can still have changed
      // underneath it - tasks.json can be hand-edited while the store is running - so existing
      // rows are always brought up to date, just never rebuilt, when nothing else moved.
      for (const task of visible) {
        const row = this._rows.get(task.id);
        if (row)
          applyRowState(row, task);
      }
      return;
    }
    this._lastKey = key;
    this._rebuildRows(visible);
  }

  // M keeps 3 rows normally; a live measurement of the open entry (an St.Entry never allocates
  // below its own text content's natural height, which reads taller here than its CSS
  // `height: 26px` alone implies - about 36-40px once its container's own padding is added) showed
  // 2 rows plus the header and the open entry landing a few pixels *past* M's 118px content area,
  // not just up against it. Only 1 row is kept while the entry is open, which measured with a
  // comfortable ~25px to spare instead. L has room for all 8 rows plus the entry either way.
  private _rowLimit(): number {
    const limit = ROW_LIMIT[this._size as 'M' | 'L'];
    return this._size === 'M' && this._entryCtl.isOpen ? 1 : limit;
  }

  private _updateS(tasks: readonly Task[]): void {
    const open = openTasks(tasks);
    if (this._countLabel)
      this._countLabel.text = String(open.length);
    if (this._nextLabel)
      this._nextLabel.text = open[0]?.title ?? 'All done';
  }

  private _updateHeader(tasks: readonly Task[]): void {
    if (this._headerCount)
      this._headerCount.text = `${openTasks(tasks).length} open`;
  }

  private _rebuildRows(tasks: readonly Task[]): void {
    const box = this._rowsBox;
    if (!box)
      return;
    box.destroy_all_children();
    this._rows.clear();
    if (tasks.length === 0) {
      box.add_child(new St.Label({ text: 'No reminders', style_class: 'desk-rem-label' }));
      return;
    }
    for (const task of tasks) {
      const row = makeRow(task, () => this._service.toggle(task.id));
      box.add_child(row.root);
      this._rows.set(task.id, row);
    }
  }

  // The order to display: whatever was shown last time (minus anything since removed), with any
  // task that turned done since - and isn't currently held in place - moved to the end; brand-new
  // tasks are appended in file order first, so they land in the "keep" bucket like any other open
  // task rather than jumping straight to the bottom.
  private _computeDisplayOrder(tasks: readonly Task[]): string[] {
    const byId = new Map(tasks.map(t => [t.id, t]));
    const prev = this._displayOrder.filter(id => byId.has(id));
    const prevSet = new Set(prev);
    const fresh = tasks.filter(t => !prevSet.has(t.id)).map(t => t.id);
    const keep: string[] = [];
    const done: string[] = [];
    for (const id of [...prev, ...fresh]) {
      if (byId.get(id)!.done && !this._heldIds.has(id))
        done.push(id);
      else
        keep.push(id);
    }
    return [...keep, ...done];
  }

  private _holdTask(id: string): void {
    this._heldIds.add(id);
    const handle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
      this._holdTimers.delete(id);
      this._heldIds.delete(id);
      if (this._lastTasks)
        this._applySnapshot(this._lastTasks);
      return GLib.SOURCE_REMOVE;
    });
    this._holdTimers.set(id, handle);
  }

  private _clearHolds(): void {
    for (const handle of this._holdTimers.values())
      GLib.Source.remove(handle);
    this._holdTimers.clear();
    this._heldIds.clear();
  }
}

export const remindersWidget: WidgetDefinition = {
  type: 'reminders',
  name: 'Reminders',
  description: 'A simple to-do list',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: {},
  options: [{ kind: 'action', key: 'clear-completed', label: 'Clear Completed' }],
  runAction: (key, hub) => {
    if (key === 'clear-completed')
      hub.tasks().clearCompleted();
  },
  create: ctx => new RemindersWidget(ctx),
};
