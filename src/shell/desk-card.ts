import Clutter from 'gi://Clutter';
import St from 'gi://St';
import type { WidgetEntry } from '../core/layout.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { DeskWidget, WidgetDefinition } from '../widgets/base.ts';
import { WidgetScope } from '../widgets/scope.ts';
import type { ThemeState } from './theme.ts';

const sameContent = (a: WidgetEntry, b: WidgetEntry) =>
  a.size === b.size && JSON.stringify(a.config) === JSON.stringify(b.config);

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
    this._content = new St.Widget({
      style_class: def.bleed ? 'desk-card-content desk-card-content-bleed' : 'desk-card-content',
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true,
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

  applyTheme(theme: ThemeState): void {
    this.actor.set_style(theme.card.css);
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
  }

  destroy(): void {
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
}
