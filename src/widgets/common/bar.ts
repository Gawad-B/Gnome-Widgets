import type Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { accentProbe, colorRgba } from './theme-color.ts';

const HEIGHT = 4;

// A thin horizontal progress bar: the same drawing technique as ProgressRing (a faint
// foreground track, an accent-coloured fill), but linear and read against whatever width the
// drawing area is actually allocated at each repaint. A plain St.Widget track-and-fill pair (the
// Weather day-range bar's own technique) only works against a track whose width is fixed at
// construction time; System's row bars stretch to the card's own width, which varies with the
// grid gap setting, so this reads get_surface_size() at paint time instead, the same way
// Sparkline does. The caller sets x_expand for a bar that should fill its row (System), or a
// fixed width for one that shouldn't (Battery's per-device rows).
export class Bar {
  readonly actor: St.DrawingArea;
  private readonly _accent: St.Widget;
  private _fraction = 0;

  constructor() {
    this.actor = new St.DrawingArea({ style_class: 'desk-bar', layout_manager: new Clutter.BinLayout() });
    this.actor.set_height(HEIGHT);
    this._accent = accentProbe();
    this.actor.add_child(this._accent);
    this.actor.connect('repaint', () => this._paint());
  }

  set(fraction: number): void {
    const clamped = Math.min(1, Math.max(0, fraction));
    if (clamped === this._fraction)
      return;
    this._fraction = clamped;
    this.actor.queue_repaint();
  }

  private _paint(): void {
    const cr = this.actor.get_context();
    const [width, height] = this.actor.get_surface_size();
    const foreground = this.actor.get_theme_node().get_foreground_color();
    const radius = height / 2;

    this._roundedRect(cr, 0, 0, width, height, radius);
    cr.setSourceRGBA(...colorRgba(foreground, 0.15));
    cr.fill();

    const fillWidth = width * this._fraction;
    if (fillWidth > 0) {
      const accent = this._accent.get_theme_node().get_foreground_color();
      this._roundedRect(cr, 0, 0, Math.max(fillWidth, Math.min(height, width)), height, radius);
      cr.setSourceRGBA(...colorRgba(accent, 1));
      cr.fill();
    }
    cr.$dispose();
  }

  private _roundedRect(cr: Cairo.Context, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
  }
}
