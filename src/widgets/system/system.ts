import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { formatPercent, formatRate } from '../../core/sysstat.ts';
import type { SystemValue } from '../../services/system.ts';
import type { Snapshot } from '../../services/service.ts';
import { DeskWidget, type WidgetContext, type WidgetDefinition } from '../base.ts';
import { Bar } from '../common/bar.ts';
import { buildStatusLabel } from '../common/message.ts';
import { ProgressRing, type RingTone } from '../common/ring.ts';
import { Sparkline } from '../common/sparkline.ts';

const RING_SIZE = 84;
const RING_WIDTH = 8;
const GB = 1024 ** 3;

const cpuTone = (cpu: number): RingTone => (cpu > 0.95 ? 'critical' : cpu > 0.8 ? 'warning' : 'accent');

// "9.8 / 16 GB": both numbers in GB without repeating the unit. Totals under 10 GB keep one
// decimal, so a 7.4 GB machine never reads "7.2 / 7 GB".
function memSummary(usedBytes: number, totalBytes: number): string {
  const total = totalBytes / GB;
  return `${(usedBytes / GB).toFixed(1)} / ${total < 10 ? total.toFixed(1) : Math.round(total)} GB`;
}

interface MetricRow { root: St.BoxLayout; value: St.Label }

function metricRow(label: string): MetricRow {
  const root = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-sys-metric' });
  const row = new St.BoxLayout({ style_class: 'desk-sys-metric-row', x_expand: true });
  row.add_child(new St.Label({ text: label, style_class: 'desk-sys-metric-label', x_expand: true }));
  const value = new St.Label({ style_class: 'desk-sys-metric-value' });
  row.add_child(value);
  root.add_child(row);
  return { root, value };
}

// S: a CPU ring, switching from accent to warning above 80% and critical above 95%. M: CPU,
// memory and (optionally) network rows, each with a thin bar underneath (network has none). L:
// the same rows with a 60-sample sparkline in place of the bar. Built once per size and state;
// each 2s publish only updates label text and calls set() on the rings, bars and sparklines
// already on screen — nothing is destroyed or rebuilt per tick. The network option can't change
// without DeskCard rebuilding the whole widget (a config change always does), so it's read once
// in the constructor.
class SystemWidget extends DeskWidget {
  private readonly _box: St.BoxLayout;
  private readonly _size: WidgetContext['size'];
  private readonly _network: boolean;
  private _mode: string | null = null;

  private _cpuRing: ProgressRing | null = null;
  private _cpuPercent: St.Label | null = null;
  private _cpuValue: St.Label | null = null;
  private _cpuBar: Bar | null = null;
  private _cpuSpark: Sparkline | null = null;
  private _memValue: St.Label | null = null;
  private _memBar: Bar | null = null;
  private _memSpark: Sparkline | null = null;
  private _netValue: St.Label | null = null;
  private _netSpark: Sparkline | null = null;

  constructor(ctx: WidgetContext) {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: `desk-sys desk-sys-${ctx.size}`,
      x_expand: true,
      y_expand: true,
    });
    super(box);
    this._box = box;
    this._size = ctx.size;
    this._network = ctx.config.network === true;
    ctx.scope.watch(ctx.hub.system(), snapshot => this._render(snapshot));
  }

  private _render(snapshot: Snapshot<SystemValue>): void {
    if (snapshot.state !== 'ready' || !snapshot.value) {
      // One mode per message, so moving from loading to error (or back) rebuilds the label.
      const text = snapshot.state === 'error' ? 'System info unavailable' : '…';
      this._show(`message:${text}`, () => this._box.add_child(buildStatusLabel(text)));
      return;
    }
    this._show('ready', () => this._build());
    this._update(snapshot.value);
  }

  private _show(mode: string, build: () => void): void {
    if (this._mode === mode)
      return;
    this._box.destroy_all_children();
    this._cpuRing = null; this._cpuPercent = null; this._cpuValue = null; this._cpuBar = null;
    this._cpuSpark = null; this._memValue = null; this._memBar = null; this._memSpark = null;
    this._netValue = null; this._netSpark = null;
    this._mode = mode;
    build();
  }

  private _build(): void {
    if (this._size === 'S') {
      this._buildRing();
      return;
    }

    const cpu = metricRow('CPU');
    this._cpuValue = cpu.value;
    this._box.add_child(cpu.root);
    if (this._size === 'M') {
      this._cpuBar = new Bar();
      this._cpuBar.actor.x_expand = true;
      cpu.root.add_child(this._cpuBar.actor);
    } else {
      this._cpuSpark = new Sparkline();
      cpu.root.add_child(this._cpuSpark.actor);
    }

    const mem = metricRow('Memory');
    this._memValue = mem.value;
    this._box.add_child(mem.root);
    if (this._size === 'M') {
      this._memBar = new Bar();
      this._memBar.actor.x_expand = true;
      mem.root.add_child(this._memBar.actor);
    } else {
      this._memSpark = new Sparkline();
      mem.root.add_child(this._memSpark.actor);
    }

    if (this._network) {
      const net = metricRow('Network');
      this._netValue = net.value;
      this._box.add_child(net.root);
      if (this._size === 'L') {
        this._netSpark = new Sparkline();
        net.root.add_child(this._netSpark.actor);
      }
    }
  }

  private _buildRing(): void {
    const col = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL, style_class: 'desk-sys-ring-col',
      x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true,
    });
    const stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
    this._cpuRing = new ProgressRing({ size: RING_SIZE, width: RING_WIDTH });
    stack.add_child(this._cpuRing.actor);
    this._cpuPercent = new St.Label({
      style_class: 'desk-sys-ring-percent', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    stack.add_child(this._cpuPercent);
    col.add_child(stack);
    col.add_child(new St.Label({
      text: 'CPU', style_class: 'desk-sys-ring-caption', x_align: Clutter.ActorAlign.CENTER,
    }));
    this._box.add_child(col);
  }

  private _update(value: SystemValue): void {
    if (this._size === 'S') {
      this._cpuRing?.set(value.cpu, cpuTone(value.cpu));
      if (this._cpuPercent)
        this._cpuPercent.text = formatPercent(value.cpu);
      return;
    }

    if (this._cpuValue)
      this._cpuValue.text = formatPercent(value.cpu);
    if (this._memValue)
      this._memValue.text = memSummary(value.mem.used, value.mem.total);
    if (this._network && this._netValue)
      this._netValue.text = `↓ ${formatRate(value.net.rx)} ↑ ${formatRate(value.net.tx)}`;

    if (this._size === 'M') {
      this._cpuBar?.set(value.cpu);
      this._memBar?.set(value.mem.fraction);
      return;
    }

    this._cpuSpark?.set([{ values: value.history.cpu, max: 1, tone: 'accent' }]);
    this._memSpark?.set([{ values: value.history.mem, max: 1, tone: 'accent' }]);
    if (this._network && this._netSpark) {
      const netMax = Math.max(...value.history.rx, ...value.history.tx, 1024);
      this._netSpark.set([
        { values: value.history.rx, max: netMax, tone: 'accent' },
        { values: value.history.tx, max: netMax, tone: 'secondary' },
      ]);
    }
  }
}

export const systemWidget: WidgetDefinition = {
  type: 'system',
  name: 'System',
  description: 'CPU, memory and network',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'S',
  defaultConfig: { network: true },
  options: [{ kind: 'toggle', key: 'network', label: 'Show network' }],
  create: ctx => new SystemWidget(ctx),
};
