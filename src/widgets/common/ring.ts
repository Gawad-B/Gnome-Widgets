import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { accentProbe, colorRgba } from './theme-color.ts';

export type RingTone = 'accent' | 'warning' | 'critical' | 'good';

const FIXED_COLORS: Record<Exclude<RingTone, 'accent'>, [number, number, number]> = {
  warning: [0xe5 / 255, 0xa5 / 255, 0x0a / 255],
  critical: [0xe0 / 255, 0x1b / 255, 0x24 / 255],
  good: [0x2e / 255, 0xc2 / 255, 0x7e / 255],
};

// A circular progress indicator: a faint track (the theme foreground at 15% alpha) and a
// clockwise arc from 12 o'clock with round caps, in either the system accent colour or one of
// three fixed state colours. Draws with Cairo the same way the clock widget's own drawing areas
// do (seconds-ring.ts, analog-face.ts): theme-node colour, get_surface_size(), cr.$dispose().
// Repaints only when set() actually changes the fraction or tone.
export class ProgressRing {
  readonly actor: St.DrawingArea;
  private readonly _lineWidth: number;
  private readonly _accent: St.Widget;
  private _fraction = 0;
  private _tone: RingTone = 'accent';

  constructor(opts: { size: number; width: number }) {
    this._lineWidth = opts.width;
    // A DrawingArea normally has no children; the accent probe below needs an explicit layout
    // manager to be added safely without St warning about an unlaid-out child.
    this.actor = new St.DrawingArea({ style_class: 'desk-ring', layout_manager: new Clutter.BinLayout() });
    this.actor.set_size(opts.size, opts.size);
    this._accent = accentProbe();
    this.actor.add_child(this._accent);
    this.actor.connect('repaint', () => this._paint());
  }

  set(fraction: number, tone: RingTone): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    if (clamped === this._fraction && tone === this._tone)
      return;
    this._fraction = clamped;
    this._tone = tone;
    this.actor.queue_repaint();
  }

  private _paint(): void {
    const cr = this.actor.get_context();
    const [width, height] = this.actor.get_surface_size();
    const node = this.actor.get_theme_node();
    const foreground = node.get_foreground_color();
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(0, Math.min(width, height) / 2 - this._lineWidth / 2);

    cr.setLineWidth(this._lineWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);

    cr.setSourceRGBA(...colorRgba(foreground, 0.15));
    cr.arc(cx, cy, radius, 0, 2 * Math.PI);
    cr.stroke();

    if (this._fraction > 0) {
      let color: [number, number, number];
      if (this._tone === 'accent') {
        const accent = this._accent.get_theme_node().get_foreground_color();
        color = [accent.red / 255, accent.green / 255, accent.blue / 255];
      } else {
        color = FIXED_COLORS[this._tone];
      }
      cr.setSourceRGB(...color);
      const start = -Math.PI / 2;
      cr.arc(cx, cy, radius, start, start + this._fraction * 2 * Math.PI);
      cr.stroke();
    }
    cr.$dispose();
  }
}
