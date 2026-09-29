import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { glassBlurRadius, glassHighlight, glassTintColor, type ColorMode } from '../core/theme-math.ts';
import { RoundedMaskEffect } from './rounded-mask.ts';

// The card's own corner radius (stylesheet.css) minus its 1px border, so the backdrop's rounded
// corner lines up with the card's own inner edge (the backdrop sits inside that border, not
// under it - see DeskCard.syncGlass) instead of poking out past it.
const MASK_RADIUS = 21;

// The blurred region extends this many multiples of the blur radius past the backdrop's own
// edge on every side, so the blur has real pixels to sample out there instead of darkening
// toward its own boundary - and stays a small multiple of the (small) card size rather than the
// whole monitor.
const BLUR_MARGIN_FACTOR = 2;

// A blurred, tinted, rounded clone of the wallpaper behind one card, positioned so it lines up
// with whatever part of the desktop that card covers.
//
// Three layers, all clipped and rounded together by one mask effect on `actor`:
//   - `_blurBox`: a small, card-sized-plus-margin window (clip_to_allocation) holding the clone
//     and the blur effect, so the blur's own offscreen framebuffer is that small window's size,
//     not the whole monitor the clone is sourced from.
//   - `_clone`: sized to the source (the primary monitor's background actor) and positioned so
//     the slice visible through `_blurBox`'s own small window lines up with the desktop behind
//     the card; blurred at that full source size before `_blurBox` clips it down, which is what
//     keeps the visible edges free of the darkening a blur run on an already-clipped texture
//     would otherwise cause.
//   - `_tint`: the glass surface color and top-edge highlight, painted over the blur. A card
//     with a live backdrop never sees its own inline surface color or box-shadow - both are
//     painted before children, and this whole actor is one opaque child sitting on top - so this
//     is where those actually become visible.
export class GlassBackdrop {
  readonly actor: Clutter.Actor;
  private readonly _blurBox: Clutter.Actor;
  private readonly _clone: Clutter.Clone;
  private readonly _blur: Shell.BlurEffect;
  private readonly _tint: St.Widget;
  private readonly _mask: RoundedMaskEffect;
  private _source: Clutter.Actor;
  private _stageX = 0;
  private _stageY = 0;
  private _width = 0;
  private _height = 0;
  private _margin = 0;

  constructor(source: Clutter.Actor) {
    this._source = source;

    this._clone = new Clutter.Clone({ source });
    this._blurBox = new Clutter.Actor({ clip_to_allocation: true });
    this._blur = new Shell.BlurEffect({ mode: Shell.BlurMode.ACTOR, brightness: 1 });
    this._blurBox.add_child(this._clone);
    this._blurBox.add_effect(this._blur);

    this._tint = new St.Widget();

    this._mask = new RoundedMaskEffect();
    this.actor = new Clutter.Actor({ clip_to_allocation: true });
    this.actor.add_child(this._blurBox);
    this.actor.add_child(this._tint);
    this.actor.add_effect(this._mask);
  }

  // `stageX`/`stageY` are the card's own position in stage coordinates, as its caller already
  // knows them from the layout — cheaper and more reliable than reading them back through this
  // actor's own transform, which needs an allocation pass to have happened first.
  setGeometry(stageX: number, stageY: number, width: number, height: number): void {
    this._stageX = stageX;
    this._stageY = stageY;
    this._width = width;
    this._height = height;
    this.actor.set_size(width, height);
    this._mask.setGeometry(width, height, MASK_RADIUS);
    this._tint.set_size(width, height);
    this._layoutBlurBox();
  }

  // `t` is translucency as a 0..1 fraction.
  setTheme(mode: ColorMode, t: number): void {
    this._blur.radius = glassBlurRadius(t);
    this._margin = this._blur.radius * BLUR_MARGIN_FACTOR;
    this._layoutBlurBox();
    this._tint.set_style(
      `background-color: ${glassTintColor(mode, t)}; box-shadow: inset 0 1px 0 ${glassHighlight(mode)}; border-radius: ${MASK_RADIUS}px;`,
    );
  }

  setSource(source: Clutter.Actor): void {
    this._source = source;
    this._clone.source = source;
    this._repositionClone();
  }

  destroy(): void {
    this.actor.destroy();
  }

  // Re-sizes and re-positions the small blurred window around the backdrop's own (unblurred)
  // bounds, then repositions the clone inside it. Needed whenever either the backdrop's geometry
  // or the margin (which depends on the blur radius, i.e. on translucency) changes.
  private _layoutBlurBox(): void {
    this._blurBox.set_position(-this._margin, -this._margin);
    this._blurBox.set_size(this._width + 2 * this._margin, this._height + 2 * this._margin);
    this._repositionClone();
  }

  // The background actor is an untransformed direct child of the background group, sitting
  // exactly at its monitor's origin — so its own `x`/`y`/`width`/`height` are already the
  // stage-space geometry the clone needs, with no transform-matrix walk required. The `+ margin`
  // accounts for `_blurBox` itself sitting `margin` pixels up and to the left of `actor`'s own
  // origin: the clone's position is relative to `_blurBox`, not to `actor`.
  private _repositionClone(): void {
    this._clone.set_size(this._source.width, this._source.height);
    this._clone.set_position(
      this._source.x - this._stageX + this._margin,
      this._source.y - this._stageY + this._margin,
    );
  }
}
