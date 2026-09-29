import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { peripheralIcon, type ChargeState } from '../../core/battery.ts';
import { formatPercent } from '../../core/sysstat.ts';
import type { BatteryValue } from '../../services/battery.ts';
import type { Snapshot } from '../../services/service.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { buildStatusLabel } from '../common/message.ts';
import { ProgressRing, type RingTone } from '../common/ring.ts';

// Content budgets (a 150/316/316px card minus desk-card-content's 16px padding each side): S
// 118x118, M 284x118, L 284x284 (see stylesheet.css's own note on the same numbers).
const GRID_SLOTS = 4;
const LIST_ROWS = 5 + 1;  // laptop + up to 5 peripherals
const S_RING = { size: 46, width: 5 };
const M_RING = { size: 54, width: 5 };

// A bolt where the icon theme has one, otherwise a charging battery (Adwaita and the user's
// MacTahoe theme both ship battery-level-90-charging; the legacy name covers older ones).
const boltIcon = (): Gio.Icon => Gio.ThemedIcon.new_from_names([
  'bolt-symbolic', 'battery-level-90-charging-symbolic', 'battery-full-charging-symbolic',
]);

// The large row's own glyph: the exact level (rounded to the nearest 10) while discharging, the
// matching -charging variant while charging, each with a same-family fallback for the one level
// (100) that has no -charging icon of its own.
function glyphIcon(percent: number, state: ChargeState): Gio.Icon {
  const level = Math.max(0, Math.min(100, Math.round(percent / 10) * 10));
  if (state === 'charging') {
    return Gio.ThemedIcon.new_from_names([
      `battery-level-${level}-charging-symbolic`, 'battery-full-charging-symbolic', 'bolt-symbolic',
    ]);
  }
  return Gio.ThemedIcon.new_from_names([`battery-level-${level}-symbolic`, 'battery-symbolic']);
}

function ringTone(percent: number, state: ChargeState): RingTone {
  if (state === 'charging' || state === 'full')
    return 'good';
  if (percent <= 10)
    return 'critical';
  if (percent <= 20)
    return 'warning';
  return 'accent';
}

interface DeviceSlot { id: string; icon: string; name: string; percent: number; state: ChargeState }

// The laptop (if present) first, named "This computer", then peripherals in the service's own
// order. S and M take the first 4 of this list; L takes all 6 (laptop + up to 5 peripherals).
function collectDevices(value: BatteryValue): DeviceSlot[] {
  const list: DeviceSlot[] = [];
  if (value.laptop) {
    list.push({
      id: 'laptop', icon: 'computer-symbolic', name: 'This computer',
      percent: value.laptop.percent, state: value.laptop.state,
    });
  }
  for (const p of value.peripherals)
    list.push({ id: p.id, icon: peripheralIcon(p.kind), name: p.name, percent: p.percent, state: p.state });
  return list;
}

// A ring slot (S and M): the device's icon centred over the ring, with a small bolt badge at its
// bottom-right corner while charging, composed with a BinLayout. M also wraps the ring in a
// column with a percentage label below it; S has neither, so an unused slot is just the bare
// track. Fixed in count (never rebuilt): each snapshot only changes which device a slot shows.
interface RingSlot { holder: St.Widget; ring: ProgressRing; icon: St.Icon; bolt: St.Icon; label: St.Label | null }

function makeRingSlot(ring: { size: number; width: number }, withLabel: boolean): RingSlot {
  const stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
  const progress = new ProgressRing(ring);
  stack.add_child(progress.actor);
  const icon = new St.Icon({
    style_class: 'desk-bat-slot-icon', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false,
  });
  stack.add_child(icon);
  const bolt = new St.Icon({
    gicon: boltIcon(), style_class: 'desk-bat-slot-bolt',
    x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END, visible: false,
  });
  stack.add_child(bolt);
  if (!withLabel)
    return { holder: stack, ring: progress, icon, bolt, label: null };
  const col = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-bat-slot-col', x_align: Clutter.ActorAlign.CENTER });
  col.add_child(stack);
  const label = new St.Label({ style_class: 'desk-bat-slot-percent', x_align: Clutter.ActorAlign.CENTER });
  col.add_child(label);
  return { holder: col, ring: progress, icon, bolt, label };
}

function updateRingSlot(slot: RingSlot, device: DeviceSlot | undefined): void {
  if (!device) {
    slot.ring.set(0, 'accent');
    slot.icon.visible = false;
    slot.bolt.visible = false;
    if (slot.label)
      slot.label.text = '';
    return;
  }
  slot.ring.set(device.percent / 100, ringTone(device.percent, device.state));
  slot.icon.icon_name = device.icon;
  slot.icon.visible = true;
  slot.bolt.visible = device.state === 'charging';
  if (slot.label)
    slot.label.text = formatPercent(device.percent / 100);
}

// An L row: icon, then a column holding the name/percentage/glyph line and a separator - nesting
// the separator under that column, not the full row, is what makes it start at the name column
// rather than under the icon. Fixed in count like the ring slots; an unused row hides everything
// but its own separator.
interface ListRow { root: St.BoxLayout; icon: St.Icon; name: St.Label; percent: St.Label; glyph: St.Icon }

function makeListRow(): ListRow {
  const root = new St.BoxLayout({ style_class: 'desk-bat-l-row', x_expand: true });
  const icon = new St.Icon({ style_class: 'desk-bat-l-icon', y_align: Clutter.ActorAlign.CENTER, visible: false });
  root.add_child(icon);

  const col = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
  const top = new St.BoxLayout({ style_class: 'desk-bat-l-top', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
  const name = new St.Label({ style_class: 'desk-bat-l-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
  name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
  top.add_child(name);
  const percent = new St.Label({ style_class: 'desk-bat-l-percent', y_align: Clutter.ActorAlign.CENTER });
  top.add_child(percent);
  const glyph = new St.Icon({ style_class: 'desk-bat-l-glyph', y_align: Clutter.ActorAlign.CENTER, visible: false });
  top.add_child(glyph);
  col.add_child(top);
  col.add_child(new St.Widget({ style_class: 'desk-bat-l-sep', x_expand: true }));
  root.add_child(col);

  return { root, icon, name, percent, glyph };
}

function updateListRow(row: ListRow, device: DeviceSlot | undefined): void {
  if (!device) {
    row.icon.visible = false;
    row.name.text = '';
    row.percent.text = '';
    row.glyph.visible = false;
    return;
  }
  row.icon.icon_name = device.icon;
  row.icon.visible = true;
  row.name.text = device.name;
  row.percent.text = formatPercent(device.percent / 100);
  row.glyph.gicon = glyphIcon(device.percent, device.state);
  row.glyph.visible = true;
}

// S: a 2x2 grid of ring slots, each showing only the device's icon (no percentage). M: the same
// slots in a row, each with its percentage below. L: a 6-row list (icon, name, percentage,
// battery-level glyph, each with its own separator). "…" while loading, "Battery info unavailable"
// on error, "No battery devices" when the laptop and every peripheral are absent. A "ready" mode
// allocates its full fixed set of slots or rows once and never rebuilds them - only their content
// changes from one snapshot to the next.
class BatteryWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private _mode: string | null = null;
  private _ringSlots: RingSlot[] = [];
  private _rows: ListRow[] = [];

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-bat desk-bat-${ctx.size}`,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;
    ctx.scope.watch(ctx.hub.battery(), snapshot => this._render(snapshot));
  }

  private _render(snapshot: Snapshot<BatteryValue>): void {
    if (snapshot.state !== 'ready' || !snapshot.value) {
      const text = snapshot.state === 'error' ? 'Battery info unavailable' : '…';
      this._show(`message:${text}`, () => this._box.add_child(buildStatusLabel(text)));
      return;
    }
    const devices = collectDevices(snapshot.value);
    if (devices.length === 0) {
      this._show('empty', () => this._box.add_child(buildStatusLabel('No battery devices')));
      return;
    }
    if (this._size === 'L') {
      this._show('list', () => this._buildList());
      for (let i = 0; i < LIST_ROWS; i++)
        updateListRow(this._rows[i]!, devices[i]);
    } else {
      this._show('grid', () => this._buildGrid());
      for (let i = 0; i < GRID_SLOTS; i++)
        updateRingSlot(this._ringSlots[i]!, devices[i]);
    }
  }

  private _show(mode: string, build: () => void): void {
    if (this._mode === mode)
      return;
    this._box.destroy_all_children();
    this._ringSlots = [];
    this._rows = [];
    this._mode = mode;
    build();
  }

  private _buildGrid(): void {
    const withLabel = this._size === 'M';
    const ring = this._size === 'S' ? S_RING : M_RING;
    this._ringSlots = Array.from({ length: GRID_SLOTS }, () => makeRingSlot(ring, withLabel));
    if (this._size === 'S') {
      const grid = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-bat-s-grid',
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true,
      });
      for (let r = 0; r < 2; r++) {
        const row = new St.BoxLayout({ style_class: 'desk-bat-s-row', x_align: Clutter.ActorAlign.CENTER });
        row.add_child(this._ringSlots[r * 2]!.holder);
        row.add_child(this._ringSlots[r * 2 + 1]!.holder);
        grid.add_child(row);
      }
      this._box.add_child(grid);
    } else {
      const row = new St.BoxLayout({
        style_class: 'desk-bat-m-row', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        x_expand: true, y_expand: true,
      });
      for (const slot of this._ringSlots)
        row.add_child(slot.holder);
      this._box.add_child(row);
    }
  }

  private _buildList(): void {
    const rows = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-bat-l-rows', x_expand: true, y_expand: true,
    });
    this._rows = Array.from({ length: LIST_ROWS }, () => makeListRow());
    for (const row of this._rows)
      rows.add_child(row.root);
    this._box.add_child(rows);
  }
}

export const batteryWidget: WidgetDefinition = {
  type: 'battery',
  name: 'Battery',
  description: 'Laptop and Bluetooth device charge',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'S',
  defaultConfig: {},
  options: [],
  create: ctx => new BatteryWidget(ctx),
};
