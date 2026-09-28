import Cairo from 'cairo';
import type GLib from 'gi://GLib';
import St from 'gi://St';

// A Cairo-drawn clock face: 12 tick marks, hour and minute hands in the text color, and an
// optional seconds hand in the accent color. Repaints when the time or the style changes.
export class AnalogFace {
  readonly actor: St.DrawingArea;
  private readonly _showSeconds: boolean;
  private _now: GLib.DateTime | null = null;

  constructor(showSeconds: boolean) {
    this._showSeconds = showSeconds;
    this.actor = new St.DrawingArea({ style_class: 'desk-analog', x_expand: true, y_expand: true });
    this.actor.connect('repaint', () => this._paint());
  }

  setTime(now: GLib.DateTime): void {
    this._now = now;
    this.actor.queue_repaint();
  }

  private _paint(): void {
    const cr = this.actor.get_context();
    const [width, height] = this.actor.get_surface_size();
    const node = this.actor.get_theme_node();
    const foreground = node.get_foreground_color();
    const [hasAccent, accent] = node.lookup_color('-desk-accent', false);
    const radius = Math.min(width, height) / 2;

    cr.translate(width / 2, height / 2);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceColor(foreground);

    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * 2 * Math.PI;
      const inner = radius * (i % 3 === 0 ? 0.78 : 0.84);
      cr.setLineWidth(i % 3 === 0 ? 3 : 1.5);
      cr.moveTo(Math.sin(angle) * inner, -Math.cos(angle) * inner);
      cr.lineTo(Math.sin(angle) * radius * 0.92, -Math.cos(angle) * radius * 0.92);
      cr.stroke();
    }

    if (this._now) {
      const seconds = this._now.get_second();
      const minutes = this._now.get_minute() + seconds / 60;
      const hours = (this._now.get_hour() % 12) + minutes / 60;
      this._hand(cr, hours / 12, radius * 0.5, 5);
      this._hand(cr, minutes / 60, radius * 0.72, 3.5);
      if (this._showSeconds) {
        if (hasAccent)
          cr.setSourceColor(accent);
        this._hand(cr, seconds / 60, radius * 0.8, 1.5);
      }
    }

    cr.arc(0, 0, 4, 0, 2 * Math.PI);
    cr.fill();
    cr.$dispose();
  }

  private _hand(cr: Cairo.Context, fraction: number, length: number, lineWidth: number): void {
    const angle = fraction * 2 * Math.PI;
    cr.setLineWidth(lineWidth);
    cr.moveTo(0, 0);
    cr.lineTo(Math.sin(angle) * length, -Math.cos(angle) * length);
    cr.stroke();
  }
}
