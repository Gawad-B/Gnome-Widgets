import Clutter from 'gi://Clutter';
import St from 'gi://St';
import type { WidgetEntry } from '../core/layout.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { DeskWidget, WidgetDefinition } from '../widgets/base.ts';
import { WidgetScope } from '../widgets/scope.ts';
import { GlassBackdrop } from './glass.ts';
import { primaryBackgroundActor } from './shell-private.ts';
import type { ThemeState } from './theme.ts';

const sameContent = (a: WidgetEntry, b: WidgetEntry) =>
  a.size === b.size && JSON.stringify(a.config) === JSON.stringify(b.config);

// The card's own border, in the same 1px that cardStyle/glassCardCss always draw it at. The
// backdrop sits inset by this much on every side, inside the border rather than under it, so the
// border itself - painted first, before any child - stays visible in that outermost ring instead
// of being covered by the backdrop the way the card's own background is.
const BORDER_WIDTH = 1;

// The themed surface a widget lives in. It owns the widget instance and contains its failures:
// a widget that throws while being built, or whose service listener throws later, is replaced
// by an error label; other cards carry on.
export class DeskCard {
  readonly actor: St.Widget;
  readonly def: WidgetDefinition;
  private readonly _hub: ServiceHub;
  private readonly _content: St.Widget;
  private _entry: WidgetEntry;
  private _widget: DeskWidget | null = null;
  private _error: St.Label | null = null;
  private _scope: WidgetScope | null = null;
  private _glass: GlassBackdrop | null = null;
  // Whether this card currently wants a backdrop, independent of whether it has one yet: a card
  // built before primaryBackgroundActor() existed (early startup, or a moment mid monitor-change)
  // still needs setGlassSource() to create one retroactively once a source finally shows up.
  private _glassOn = false;
  // The last theme applied, so a backdrop created later (once a background actor exists) starts
  // with the right blur and tint instead of the effect defaults.
  private _theme: ThemeState | null = null;

  constructor(entry: WidgetEntry, def: WidgetDefinition, hub: ServiceHub) {
    this._entry = entry;
    this.def = def;
    this._hub = hub;
    this.actor = new St.Widget({
      style_class: 'desk-card',
      reactive: true,
      layout_manager: new Clutter.BinLayout(),
    });
    // Inset from the card edge by .desk-card-content's padding; holds the widget actor (or the
    // error label). The edit shield (added later, in edit-mode.ts) is a sibling of this, added
    // directly to `actor`, so it still covers the padding band and the full card, not just this
    // inset area. A widget whose definition opts out of that padding (def.bleed, e.g. the seconds
    // ring drawing all the way to the card's own edge) gets desk-card-content-bleed instead,
    // which zeroes it (stylesheet.css) — the widget is then responsible for insetting its own
    // non-bleeding layouts.
    //
    // clip_to_allocation bounds this card's paint volume to its own box no matter what a widget
    // does inside it. The Dimmer's DesaturateEffect renders the whole layer through one offscreen
    // framebuffer sized from the layer's paint volume, so a single descendant with a runaway
    // allocation (St turns a negative `margin` shorthand into ~2^32px) would otherwise make that
    // framebuffer impossible to allocate and blank every card on the desktop, not just this one.
    this._content = new St.Widget({
      style_class: def.bleed ? 'desk-card-content desk-card-content-bleed' : 'desk-card-content',
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
      clip_to_allocation: true,
    });
    this.actor.add_child(this._content);
    this._build();
  }

  get entry(): WidgetEntry {
    return this._entry;
  }

  // Stores a new entry; the widget is rebuilt only when its size or config changed.
  update(entry: WidgetEntry): void {
    const rebuild = !sameContent(this._entry, entry);
    this._entry = entry;
    if (rebuild)
      this._build();
  }

  // `withGlassBackdrop` is false for the gallery's scaled-down preview tiles: they aren't
  // positioned over any meaningful stretch of wallpaper (the gallery panel itself covers
  // whatever would be behind them), so a live blurred clone there would show the wrong thing at
  // the wrong blur-to-scale ratio for no benefit. They still pick up the glass surface tint and
  // rim below, which is enough to preview the look.
  applyTheme(theme: ThemeState, withGlassBackdrop = true): void {
    this.actor.set_style(theme.glass ? theme.glassCss : theme.card.css);
    if (theme.glass)
      this.actor.add_style_class_name('desk-card-glass');
    else
      this.actor.remove_style_class_name('desk-card-glass');
    if (theme.card.outlineTracks)
      this.actor.add_style_class_name('desk-tracks-outline');
    else
      this.actor.remove_style_class_name('desk-tracks-outline');
    // The edit-mode outline (stylesheet.css, drawn on the shield) only kicks in above 70%
    // translucency, distinct from the 50% threshold that switches ring/graph tracks to outlines.
    if (theme.translucency > 70)
      this.actor.add_style_class_name('desk-card-faint');
    else
      this.actor.remove_style_class_name('desk-card-faint');

    this._theme = theme;
    this._glassOn = theme.glass && withGlassBackdrop;
    if (this._glassOn)
      this._ensureGlass(theme);
    else
      this._teardownGlass();
  }

  // Called by the layer whenever the primary background actor changes (wallpaper swap, monitor
  // change) or the layer itself moves (a monitor added to its left, a strut change). A no-op
  // while this card doesn't want a backdrop; creates one on the spot if it wants one but doesn't
  // have it yet (the source wasn't available when applyTheme() last ran).
  setGlassSource(source: Clutter.Actor): void {
    if (!this._glassOn)
      return;
    if (this._glass)
      this._glass.setSource(source);
    else
      this._createGlass(source);
    this.syncGlass();
  }

  // Recomputes the backdrop's geometry from this card's current position and size. Called
  // whenever either actually changes (this card's own notify::allocation listener below), and
  // also by the layer whenever *it* moves instead - a card's position is a fixed offset from the
  // layer's origin, so the card's own allocation never changes just because the layer's did.
  //
  // A card that has never been through a relayout yet - freshly added, before DeskLayer's own
  // relayout() has positioned it for the first time - has no real transform to read yet, and
  // get_transformed_position() answers with NaN rather than anything usable; skip it rather
  // than feed that through to an actor allocation. The relayout() already about to run fires
  // this card's own notify::allocation and calls back in here with real numbers moments later.
  syncGlass(): void {
    if (!this._glass)
      return;
    const [x, y] = this.actor.get_transformed_position();
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return;
    this._glass.setGeometry(
      x + BORDER_WIDTH, y + BORDER_WIDTH,
      this.actor.width - 2 * BORDER_WIDTH, this.actor.height - 2 * BORDER_WIDTH,
    );
  }

  destroy(): void {
    this._teardownGlass();
    this._scope?.dispose();
    this._scope = null;
    this._widget?.destroy();
    this._widget = null;
    this._error?.destroy();
    this._error = null;
    this.actor.destroy();
  }

  private _build(): void {
    this._scope?.dispose();
    this._scope = null;
    this._widget?.destroy();
    this._widget = null;
    this._error?.destroy();
    this._error = null;

    const { size, config } = this._entry;
    const scope = new WidgetScope(e => this._showError(e));
    this._scope = scope;
    try {
      const widget = this.def.create({
        size, config: { ...this.def.defaultConfig, ...config }, hub: this._hub, scope,
      });
      // A watched listener can throw during create()'s own synchronous first delivery (the
      // common case: the shared service is already ready, e.g. a second clock, or any
      // rebuild), reporting through WidgetScope's onError and replacing this card with an
      // error label before create() even returns. Don't resurrect that widget over the label:
      // if this scope is no longer the card's current one, the failure already happened.
      if (this._scope !== scope) {
        widget.destroy();
        return;
      }
      this._widget = widget;
      this._content.add_child(this._widget.actor);
    } catch (e) {
      this._showError(e);
    }
  }

  // Replaces whatever content the card currently has with an error label. Called either
  // synchronously from _build() (the widget threw while being constructed) or later, through
  // WidgetScope's onError, from inside a service publish that a widget's listener let escape.
  // Safe either way: disposing the scope mid-publish only unsubscribes it (Service already
  // supports that), and destroying the widget here just tears down its actor.
  //
  // Idempotent past the first failure: a widget that throws once while being built (from
  // def.create() itself) and then again from a watched listener's synchronous first delivery
  // (both within the same _build() call) is one failure from the card's point of view, so
  // only the first call logs and tears anything down; once an error label exists, later calls
  // are no-ops.
  private _showError(e: unknown): void {
    if (this._error)
      return;
    console.error(`Desk Widgets: ${this.def.type} widget ${this._entry.id} failed`, e);
    this._scope?.dispose();
    this._scope = null;
    this._widget?.destroy();
    this._widget = null;
    this._error = new St.Label({
      text: 'Widget error',
      style_class: 'desk-card-error',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._content.add_child(this._error);
  }

  // Creates the backdrop on first use (its actor goes in below the widget content, as the card's
  // first child), then keeps its theme and geometry current either way. No-ops until a primary
  // background actor exists (early startup, or a moment mid monitor-change) - setGlassSource()
  // above is what creates it retroactively once one does.
  private _ensureGlass(theme: ThemeState): void {
    if (!this._glass) {
      const source = primaryBackgroundActor();
      if (!source)
        return;
      this._createGlass(source);
    }
    this._glass?.setTheme(theme.mode, theme.translucency / 100);
    this.syncGlass();
  }

  private _createGlass(source: Clutter.Actor): void {
    this._glass = new GlassBackdrop(source);
    if (this._theme)
      this._glass.setTheme(this._theme.mode, this._theme.translucency / 100);
    this.actor.insert_child_at_index(this._glass.actor, 0);
    // The card's own position can change without going through any method here - a drag in
    // edit mode sets card.actor's position directly - so the backdrop tracks it by listening for
    // the allocation Clutter recomputes whenever position or size actually changes, instead of
    // needing every caller that might move or resize the card to know about glass.
    this.actor.connectObject('notify::allocation', () => this.syncGlass(), this);
  }

  private _teardownGlass(): void {
    if (!this._glass)
      return;
    this.actor.disconnectObject(this);
    this._glass.destroy();
    this._glass = null;
  }
}
