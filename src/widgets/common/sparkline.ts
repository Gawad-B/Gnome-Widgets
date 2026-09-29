import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { HISTORY } from '../../core/sysstat.ts';
import { accentProbe } from './theme-color.ts';

export type SparkTone = 'accent' | 'secondary';
export interface SparkSeries { values: readonly number[]; max: number; tone: SparkTone }

const DEFAULT_HEIGHT = 56;

// A small line graph over the last HISTORY slots of one or more series, right-aligned so a
// history still filling up hugs the drawing area's right edge instead of stretching across it.
// The first series also gets a faint fill under its line. Draws with Cairo the same way the
// clock widget's own drawing areas do. Unlike ProgressRing, this repaints on every set() call:
// a sparkline's whole point is to show freshly-arrived history data, which is expected to
// differ on every sample.
const LINE_WIDTH = 1.5;

export class Sparkline {
  readonly actor: St.DrawingArea;
  private readonly _accent: St.Widget;
  private _series: SparkSeries[] = [];

  constructor() {
    this.actor = new St.DrawingArea({
      style_class: 'desk-sparkline', layout_manager: new Clutter.BinLayout(), x_expand: true,
    });
    this.actor.set_height(DEFAULT_HEIGHT);
    this._accent = accentProbe();
    this.actor.add_child(this._accent);
    this.actor.connect('repaint', () => this._paint());
  }

  set(series: SparkSeries[]): void {
    this._series = series;
    this.actor.queue_repaint();
  }

  private _paint(): void {
    const cr = this.actor.get_context();
    const [width, height] = this.actor.get_surface_size();
    const foreground = this.actor.get_theme_node().get_foreground_color();
    const accent = this._accent.get_theme_node().get_foreground_color();

    this._series.forEach((series, index) => {
      const points = this._points(series, width, height);
      if (points.length === 0)
        return;
      const [r, g, b] = series.tone === 'accent'
        ? [accent.red / 255, accent.green / 255, accent.blue / 255]
        : [foreground.red / 255, foreground.green / 255, foreground.blue / 255];

      if (index === 0 && points.length > 1) {
        cr.setSourceRGBA(r, g, b, 0.12);
        cr.moveTo(points[0]!.x, height);
        for (const p of points)
          cr.lineTo(p.x, p.y);
        cr.lineTo(points[points.length - 1]!.x, height);
        cr.closePath();
        cr.fill();
      }

      cr.setSourceRGBA(r, g, b, series.tone === 'accent' ? 0.9 : 0.6);
      cr.setLineWidth(LINE_WIDTH);
      cr.moveTo(points[0]!.x, points[0]!.y);
      for (const p of points.slice(1))
        cr.lineTo(p.x, p.y);
      cr.stroke();
    });
    cr.$dispose();
  }

  // Maps a series' values onto the drawing area, right-aligned within the last HISTORY slots:
  // slot i of a series with fewer than HISTORY samples is HISTORY - values.length + i, so a
  // history still filling up starts partway across instead of stretching its few points over
  // the whole width.
  private _points(series: SparkSeries, width: number, height: number): Array<{ x: number; y: number }> {
    const { values, max } = series;
    if (values.length === 0 || max <= 0)
      return [];
    const step = HISTORY > 1 ? width / (HISTORY - 1) : width;
    const offset = HISTORY - values.length;
    // Inset by half the line width so a value at 0 or at max isn't half-clipped at the edge.
    const inset = LINE_WIDTH / 2;
    const span = Math.max(0, height - 2 * inset);
    return values.map((value, i) => ({
      x: (offset + i) * step,
      y: height - inset - Math.min(1, Math.max(0, value / max)) * span,
    }));
  }
}
