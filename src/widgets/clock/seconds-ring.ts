import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { blendTickAlpha, ringTicks, tickAlpha, type Tick } from '../../core/seconds-ring.ts';

// .desk-card's own border-radius (stylesheet.css): a fixed 22px regardless of the widget's grid
// size, so the ring's own radius must stay fixed too (see RING_OFFSET) to stay concentric with
// the card's actual rounded corner instead of drifting off-centre.
const CARD_RADIUS = 22;
// Fallback for when the card ancestor's border width can't be read yet (see _cardBorderWidth()).
// Matches theme-math.ts's `border: 1px solid ...`, which is always 1px regardless of translucency.
const DEFAULT_BORDER = 1;
// How far inside the card's border the ring sits, measured in the ring actor's own frame (whose
// origin already starts just inside that border, since ClockWidget's `bleed: true` gives it the
// card's full interior instead of desk-card-content's usual 16px padding — see base.ts and
// desk-card.ts). Deliberately not scaled by size: the card's corner radius is one fixed 22px
// regardless of the widget's grid size, so eroding it by a size-dependent amount would pull the
// ring's corners off-centre from the card's own corner on every size but one.
const RING_OFFSET = 6;

const TICK_LENGTH = 7;
const LINE_WIDTH = 2.25;
const MAX_LINE_WIDTH = 3.25;
// One grid cell (150px, core/grid.ts's CELL) minus the card's own ~1px border on each side: S's
// own drawing-area size now that it bleeds to the card edge (see RING_OFFSET above), and M's
// short dimension too (M is one row tall). Line width scales up gently above this reference (capped
// at MAX_LINE_WIDTH) and never shrinks below it, so L (a 2×2 cell) gets a slightly heavier ring;
// tick length is capped at half the corner radius (see _paint).
const REFERENCE_SIZE = 148;

// How long a single second's step takes to settle, and the easing shape it settles with. Chosen
// so the tick-to-tick jump the user found jarring reads as a smooth, quick settle instead —
// noticeably eased, but well under a second so it never runs into the *next* step.
const STEP_DURATION_MS = 400;

// St.DrawingArea wrapper for the seconds ring: 60 short ticks around the card's rounded edge,
// with a bright trail (via tickAlpha) that follows the current second clockwise. Draws with
// Cairo the same way analog-face.ts does. Each second's step is animated (see setSecond): a
// tick's alpha eases from its previous value to tickAlpha's new one over STEP_DURATION_MS,
// instead of jumping straight to it.
//
// Cost: while a step is animating, the timeline's 'new-frame' queues a repaint on (up to) every
// stage frame for STEP_DURATION_MS (~400ms) out of every second; the rest of that second, with no
// timeline running, costs nothing. St.Settings.get().enable_animations off skips the animation
// entirely and steps instantly, as before.
export class SecondsRing {
  readonly actor: St.DrawingArea;
  // The second the ring is currently settled on or animating towards.
  private _toSecond = 0;
  // Per-tick alpha the current animation leg started from, snapshotted at the moment it started
  // (see setSecond) so restarting mid-animation blends from what's actually on screen, not from
  // some earlier leg's nominal start second. null once settled (or before the first real second
  // arrives) — _alphaFor then reads tickAlpha(i, _toSecond) directly.
  private _fromAlphas: number[] | null = null;
  private _timeline: Clutter.Timeline | null = null;
  private _initialized = false;
  private _border: number | null = null;
  // ringTicks's own result for the last (width, height, border, scale) it was called with - all
  // four only ever change on a resize or a theme-node change (a scale change always comes with a
  // width/height change too, since it's derived from them), never between one second's repaint
  // and the next, so recomputing 60 tick endpoints on every repaint (up to every frame of a
  // 400ms animation leg) was pure waste. Recomputed only when the key below actually changes.
  private _ticksCache: { width: number; height: number; border: number; scale: number; ticks: Tick[] } | null = null;

  constructor() {
    this.actor = new St.DrawingArea({ style_class: 'desk-seconds-ring', x_expand: true, y_expand: true });
    this.actor.connect('repaint', () => this._paint());
    this.actor.connect('destroy', () => this._stopTimeline());
  }

  setSecond(second: number): void {
    // The very first call (the service's synchronous initial delivery) has no real previous
    // second to animate from, so it snaps instead of easing in from an arbitrary default. Checked
    // before the dedup guard below: `_toSecond` also starts at 0, so if the first real second
    // ever delivered were 0 too, that guard would return early and leave `_initialized` false -
    // silently turning the *next* call into a second "first call" that snaps instead of animates.
    if (!this._initialized) {
      this._initialized = true;
      this._toSecond = second;
      this.actor.queue_repaint();
      return;
    }
    if (second === this._toSecond)
      return;
    // Off-stage (being built or torn down) or animations off: step instantly. A timeline on an
    // actor that isn't on the stage is unsupported by Clutter.
    if (!St.Settings.get().enable_animations || !this.actor.get_stage()) {
      this._toSecond = second;
      this._fromAlphas = null;
      this._stopTimeline();
      this.actor.queue_repaint();
      return;
    }
    // Snapshot what's actually on screen for every tick right now — including a still-running
    // previous leg's own blended, in-between values — so restarting here is continuous: the new
    // leg eases from exactly this, never from a stale target that would jump.
    const snapshot: number[] = [];
    for (let i = 0; i < 60; i++)
      snapshot.push(this._alphaFor(i));
    this._fromAlphas = snapshot;
    this._toSecond = second;
    this._startTimeline();
  }

  private _startTimeline(): void {
    this._stopTimeline();
    const timeline = new Clutter.Timeline({ duration: STEP_DURATION_MS, actor: this.actor });
    timeline.connect('new-frame', () => this.actor.queue_repaint());
    timeline.connect('completed', () => {
      this._fromAlphas = null;
      this._timeline = null;
      this.actor.queue_repaint();
    });
    this._timeline = timeline;
    timeline.start();
  }

  private _stopTimeline(): void {
    this._timeline?.stop();
    this._timeline = null;
  }

  // The alpha to actually paint tick `i` with right now: mid-animation, that's core/seconds-ring.ts's
  // own blendTickAlpha (unit-tested for continuity); settled (no timeline), it's just tickAlpha's
  // own value for the current second. This method's only job is reading the timeline's raw
  // progress and the snapshot array - the actual blend math lives in core, not here.
  private _alphaFor(i: number): number {
    const from = this._fromAlphas;
    if (!from || !this._timeline)
      return tickAlpha(i, this._toSecond);
    return blendTickAlpha(from[i]!, i, this._toSecond, this._timeline.get_progress());
  }

  private _paint(): void {
    const cr = this.actor.get_context();
    const [width, height] = this.actor.get_surface_size();
    const node = this.actor.get_theme_node();
    const foreground = node.get_foreground_color();
    const scale = Math.max(1, Math.min(width, height) / REFERENCE_SIZE);

    this._border ??= this._cardBorderWidth();
    const radius = Math.max(0, CARD_RADIUS - this._border - RING_OFFSET);

    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(Math.min(LINE_WIDTH * scale, MAX_LINE_WIDTH));

    // Capped at half the corner radius: the corner radius stays 15px on every size, so a tick
    // scaled up for L (~15px) would reach the corner's centre and fuse with its neighbour into a V.
    const ticks = this._ticksFor(width, height, this._border, scale, radius);
    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]!;
      const alpha = this._alphaFor(i);
      cr.setSourceRGBA(foreground.red / 255, foreground.green / 255, foreground.blue / 255, alpha);
      cr.moveTo(tick.x1, tick.y1);
      cr.lineTo(tick.x2, tick.y2);
      cr.stroke();
    }
    cr.$dispose();
  }

  // ringTicks's result only ever changes with the drawing area's size, its card ancestor's
  // border width, or the derived line/tick scale - never from one repaint to the next at a fixed
  // size, including every frame of a 400ms step animation. Recomputes only when one of those four
  // actually differs from the cached call.
  private _ticksFor(width: number, height: number, border: number, scale: number, radius: number): Tick[] {
    const cache = this._ticksCache;
    if (cache && cache.width === width && cache.height === height && cache.border === border && cache.scale === scale)
      return cache.ticks;
    const ticks = ringTicks(width, height, RING_OFFSET, radius, 60, Math.min(TICK_LENGTH * scale, radius / 2));
    this._ticksCache = { width, height, border, scale, ticks };
    return ticks;
  }

  // Walks up to the ancestor .desk-card actor (ClockWidget's own top-level box bleeds directly
  // into its content wrapper — see WidgetDefinition.bleed) and reads its real border width off
  // its theme node, instead of just assuming DEFAULT_BORDER. Cached once found: theme-math.ts's
  // border is always 1px regardless of translucency, so it never needs to change again for a
  // given ring instance, and re-walking the tree on every repaint would be wasted work.
  private _cardBorderWidth(): number {
    let actor: Clutter.Actor | null = this.actor.get_parent();
    for (let i = 0; i < 10 && actor; i++) {
      if (actor instanceof St.Widget && actor.has_style_class_name('desk-card'))
        return actor.get_theme_node().get_border_width(St.Side.TOP);
      actor = actor.get_parent();
    }
    return DEFAULT_BORDER;
  }
}
