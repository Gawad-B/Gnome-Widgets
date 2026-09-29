import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { cellToPoint, snap, spanPixels, type Cell, type SizeName } from '../core/grid.ts';
import type { DeskCard } from './desk-card.ts';
import type { DeskLayer } from './desk-layer.ts';
import type { Dimmer } from './dimmer.ts';

const SETTLE_MS = 200;
const BADGE_OFFSET = 10;

interface Decoration {
  card: DeskCard;
  shield: St.Widget;
  badge: St.Button;
}

// Edit mode lifts the widget layer above all windows over a dimmed backdrop, grabs input, shows
// the grid, and lets cards be dragged (snapping to cells) or removed. Esc exits.
export class EditMode {
  private readonly _layer: DeskLayer;
  private readonly _dimmer: Dimmer;
  private readonly _decorations = new Map<string, Decoration>();
  private readonly _enterHooks: Array<(container: St.Widget) => void> = [];
  private readonly _exitHooks: Array<() => void> = [];
  private _container: St.Widget | null = null;
  private _grab: Clutter.Grab | null = null;
  private _dots: St.DrawingArea | null = null;
  private _placeholder: St.Widget | null = null;
  private _unsubscribeLayer: (() => void) | null = null;
  // Watches uiGroup for new chrome siblings (e.g. a dock re-adding itself) while editing, so the
  // container can be raised back above them; see the comment where it's connected below.
  private _chromeWatch = 0;
  // A pending idle callback that re-asserts the container's position after a 'child-added' event
  // this session hasn't already scheduled one for; see the comment where it's scheduled below.
  private _chromeIdle = 0;
  // The Meta keybinding action id for the edit-mode shortcut (0 until set). While editing, the
  // modal grab runs the stage in Shell.ActionMode.NONE, so Main.wm's own NORMAL-mode keybinding
  // handler never fires for it; this lets the container's own key handler recognize the same
  // key combo and toggle back out.
  private _toggleAction = 0;

  constructor(layer: DeskLayer, dimmer: Dimmer) {
    this._layer = layer;
    this._dimmer = dimmer;
  }

  get active(): boolean {
    return this._container !== null;
  }

  onEnter(fn: (container: St.Widget) => void): void {
    this._enterHooks.push(fn);
  }

  onExit(fn: () => void): void {
    this._exitHooks.push(fn);
  }

  // Called once from extension.ts right after Main.wm.addKeybinding() registers the shortcut,
  // with the action id it returned (non-zero on success), so the container's key handler below
  // can recognize the same combo and exit even though the global keybinding itself is filtered
  // out by the modal grab's action mode.
  setToggleAction(action: number): void {
    this._toggleAction = action;
  }

  toggle(): void {
    if (this.active)
      this.exit();
    else
      this.enter();
  }

  enter(): void {
    if (this._container)
      return;
    const { width, height } = global.stage;
    const container = new St.Widget({ name: 'desk-widgets-edit', reactive: true, x: 0, y: 0, width, height });
    container.add_child(new St.Widget({ style_class: 'desk-edit-backdrop', x: 0, y: 0, width, height }));
    Main.layoutManager.uiGroup.insert_child_above(container, global.window_group);
    this._container = container;
    // Desktop chrome - a dock, the top bar - is added below global.top_window_group and can reveal
    // itself while we're up (a dock un-hiding because no window is left to dodge), covering the
    // backdrop and gallery at the bottom of the screen. Sitting directly below top_window_group
    // keeps the container above all of that chrome, while modal dialogs, the on-screen keyboard
    // and popup menus (all above top_window_group, and a BoxPointer raises itself on open) still
    // draw on top. Chrome added while editing lands just below top_window_group too, i.e. above
    // us, so the position is re-asserted whenever a sibling is added.
    const uiGroup = Main.layoutManager.uiGroup;
    const placeAboveChrome = () => {
      if (uiGroup.contains(global.top_window_group))
        uiGroup.set_child_below_sibling(container, global.top_window_group);
    };
    placeAboveChrome();
    this._chromeWatch = uiGroup.connect('child-added', (_group, child) => {
      if (child === container || this._chromeIdle)
        return;
      // Main.layoutManager.addChrome() adds the actor (this 'child-added' fires here, mid-call)
      // and *then* reorders that same actor to sit below top_window_group via its own
      // set_child_below_sibling() call - a plain reorder, which fires no signal of its own. Since
      // that second step runs after this handler returns, re-asserting synchronously here can
      // still lose the race and leave the container displaced right back under the new chrome.
      // Deferring to the next idle runs after addChrome()'s whole call (and any of its own
      // follow-up reordering) has already finished, so the reassertion is never undone by it.
      this._chromeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._chromeIdle = 0;
        if (this._container === container)
          placeAboveChrome();
        return GLib.SOURCE_REMOVE;
      });
    });

    // From here on, `container` is up and `this._container` is set, so any throw (a hook is
    // caught individually below, but reparenting, the grab, or anything else here could still
    // throw) must not strand edit mode half-entered: exit() knows how to unwind every piece it
    // finds already in place (each step in its teardown is itself guarded), so routing the
    // failure through it, instead of leaving `active` stuck true over a broken container, is
    // its own safety net.
    try {
      this._layer.reparent(container);
      this._dots = new St.DrawingArea({ style_class: 'desk-edit-dots' });
      this._dots.connect('repaint', () => this._paintDots());
      this._placeholder = new St.Widget({ style_class: 'desk-edit-placeholder', visible: false });
      this._layer.actor.insert_child_at_index(this._dots, 0);
      this._layer.actor.insert_child_at_index(this._placeholder, 1);
      this._unsubscribeLayer = this._layer.onChanged(() => this._sync());
      this._sync();

      container.connect('key-press-event', (_actor, event) => {
        const isEscape = event.get_key_symbol() === Clutter.KEY_Escape;
        const isToggle = this._toggleAction !== 0 &&
          global.display.get_keybinding_action(event.get_key_code(), event.get_state()) === this._toggleAction;
        if (!isEscape && !isToggle)
          return Clutter.EVENT_PROPAGATE;
        // X11-style auto-repeat while a key is held sends repeated key-press events (no matching
        // key-release between them). A held toggle shortcut must not flicker in and out of edit
        // mode on every repeat; only the initial press (and Esc, which isn't auto-repeated the
        // same way here) should act. A second, distinct tap still toggles normally.
        if (isToggle && (event.get_flags() & Clutter.EventFlags.FLAG_REPEATED) !== 0)
          return Clutter.EVENT_STOP;
        this.exit();
        return Clutter.EVENT_STOP;
      });
      this._grab = Main.pushModal(container);
      this._dimmer.setEditing(true);
      for (const hook of this._enterHooks) {
        try {
          hook(container);
        } catch (e) {
          console.error('Desk Widgets: edit-mode enter hook failed', e);
        }
      }
    } catch (e) {
      console.error('Desk Widgets: edit-mode enter failed', e);
      this.exit();
    }
  }

  exit(): void {
    const container = this._container;
    if (!container)
      return;
    // Cleared up front, before anything else runs: a hook that calls exit() again (reentrant)
    // then sees `active` already false and can't re-enter teardown, and _sync()'s guard (which
    // reads this same field) is already tripped for the rest of this method, including the
    // synchronous drag-cancel cascade the comment below describes.
    this._container = null;
    // Hooks (the gallery) run first, but a throwing hook must never strand the modal
    // grab or leave the container up: the teardown below always runs via finally.
    try {
      for (const hook of this._exitHooks) {
        try {
          hook();
        } catch (e) {
          console.error('Desk Widgets: edit-mode exit hook failed', e);
        }
      }
    } finally {
      // Each step below runs even if an earlier one throws: this teardown is the only thing
      // standing between a broken step and two outcomes that must never happen no matter what -
      // `Main.popModal(this._grab)` left uncalled (every key and pointer event in the real
      // session stays grabbed to a container we're in the middle of tearing down) and
      // `container.destroy()` left uncalled (that full-stage actor tree, plus everything still
      // parented under it, leaks for the rest of the session). A single flat sequence would let
      // a throw from, say, a decoration's destroy() skip both.
      const safely = (fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          console.error('Desk Widgets: edit-mode exit teardown step failed', e);
        }
      };
      // Unsubscribe before destroying decorations: destroying a shield mid-drag detaches its
      // PanGesture, and Mutter cancels the in-progress sequence synchronously on detach, so our
      // 'cancel' handler can fire *inside* this destroy loop (the card is still in
      // `_layer.cards` at that point) and call back into _drop() -> relayout() -> this listener
      // -> _sync(). Removing the listener first means that cascade can't reach _sync() at all,
      // so it never touches a badge this loop has already destroyed.
      safely(() => {
        this._unsubscribeLayer?.();
        this._unsubscribeLayer = null;
      });
      safely(() => {
        if (this._chromeWatch) {
          Main.layoutManager.uiGroup.disconnect(this._chromeWatch);
          this._chromeWatch = 0;
        }
        if (this._chromeIdle) {
          GLib.source_remove(this._chromeIdle);
          this._chromeIdle = 0;
        }
      });
      safely(() => {
        for (const decoration of this._decorations.values()) {
          decoration.shield.destroy();
          decoration.badge.destroy();
        }
        this._decorations.clear();
      });
      safely(() => {
        this._dots?.destroy();
        this._dots = null;
      });
      safely(() => {
        this._placeholder?.destroy();
        this._placeholder = null;
      });
      safely(() => {
        if (this._grab) {
          Main.popModal(this._grab);
          this._grab = null;
        }
      });
      safely(() => {
        this._layer.restore();
        // The reparent above can interrupt a drop or drag-cancel settle ease still in flight
        // (e.g. Esc pressed mid-drag or mid-settle), leaving a card off-grid or overlapping
        // another for the rest of the session. Clear any leftover transition and relayout so
        // every card ends up exactly where the persisted layout says it should be.
        for (const card of this._layer.cards.values()) {
          card.actor.remove_transition('x');
          card.actor.remove_transition('y');
        }
        this._layer.relayout();
      });
      safely(() => container.destroy());
      safely(() => this._dimmer.setEditing(false));
    }
  }

  destroy(): void {
    this.exit();
    this._enterHooks.length = 0;
    this._exitHooks.length = 0;
  }

  showPlaceholder(size: SizeName, cell: Cell, valid: boolean): void {
    if (!this._placeholder)
      return;
    const geo = this._layer.geometry;
    const { x, y } = cellToPoint(geo, cell);
    const { width, height } = spanPixels(geo, size);
    this._placeholder.set_position(x, y);
    this._placeholder.set_size(width, height);
    if (valid)
      this._placeholder.remove_style_class_name('desk-edit-placeholder-invalid');
    else
      this._placeholder.add_style_class_name('desk-edit-placeholder-invalid');
    this._placeholder.show();
  }

  hidePlaceholder(): void {
    this._placeholder?.hide();
  }

  // Reconciles decorations with the layer's cards and repositions the badges.
  private _sync(): void {
    // A _drop() ease's onComplete, or a synchronous drag-cancel cascading out of exit()'s own
    // teardown, can still reach here after exit() has started (this._container is cleared at
    // the very top of exit(), before anything else runs); without this guard it would
    // re-decorate cards, or touch decorations exit() has already destroyed, in normal mode.
    if (!this._container)
      return;
    const cards = this._layer.cards;
    for (const [id, decoration] of this._decorations) {
      if (cards.get(id) === decoration.card)
        continue;
      // The card was removed or rebuilt: its shield died with it; the badge is a layer child.
      decoration.badge.destroy();
      this._decorations.delete(id);
    }
    for (const [id, card] of cards) {
      if (!this._decorations.has(id))
        this._decorations.set(id, this._decorate(card));
    }
    for (const { card, badge } of this._decorations.values()) {
      badge.set_position(card.actor.x - BADGE_OFFSET, card.actor.y - BADGE_OFFSET);
      badge.visible = card.actor.visible;
      this._layer.actor.set_child_above_sibling(badge, null);
    }
    if (this._dots) {
      this._dots.set_size(this._layer.actor.width, this._layer.actor.height);
      this._dots.queue_repaint();
    }
  }

  private _decorate(card: DeskCard): Decoration {
    // The shield covers the widget (including its padding, since it's added directly to
    // card.actor rather than into desk-card-content) so its own buttons don't react while
    // editing, and carries the drag. It also carries the faint outline: the card's own inline
    // style (set by DeskCard.applyTheme) always beats a stylesheet rule targeting the card
    // itself, so the outline is drawn on this un-styled shield instead (see stylesheet.css).
    const shield = new St.Widget({ style_class: 'desk-edit-shield', reactive: true, x_expand: true, y_expand: true });
    card.actor.add_child(shield);
    shield.add_action(this._dragGesture(card));

    const badge = new St.Button({ style_class: 'desk-remove-badge', label: '−', can_focus: true });
    badge.connect('clicked', () => this._layer.removeWidget(card.entry.id));
    this._layer.actor.add_child(badge);
    return { card, shield, badge };
  }

  private _dragGesture(card: DeskCard): Clutter.PanGesture {
    const pan = new Clutter.PanGesture({ required_button: Clutter.BUTTON_PRIMARY });
    let start: { x: number; y: number; px: number; py: number } | null = null;

    const target = (): Cell => snap(this._layer.geometry, card.entry.size, { x: card.actor.x, y: card.actor.y });

    // Bails out of end/cancel (still clearing `start` and hiding the placeholder) when the card
    // was destroyed mid-drag, e.g. an external layout reset rebuilding every card.
    const stillLive = (): boolean => this._layer.cards.get(card.entry.id) === card;

    pan.connect('recognize', () => {
      // get_begin_centroid_abs() (stage-relative, like get_centroid_abs()) is the point the
      // gesture actually began at, fixed for the life of the gesture. get_centroid_abs() at
      // `recognize` time already reflects however far the pointer moved past begin_threshold to
      // get here, so anchoring the offset to it would make the card jump to align with the
      // pointer's *current* position instead of preserving the offset from where the press
      // started, i.e. trailing/snapping instead of tracking 1:1 from the first pan-update.
      // get_centroid() is actor-relative, and the actor here (the shield) moves with the card
      // being dragged, so it would measure each update against the card's own last position
      // instead of the pointer. The layer is unscaled, so stage-space deltas equal layer-space
      // deltas.
      const point = pan.get_begin_centroid_abs();
      start = { x: card.actor.x, y: card.actor.y, px: point.x, py: point.y };
      // A grab mid-settle (the card easing back from a previous drop) must not fight that ease.
      card.actor.remove_transition('x');
      card.actor.remove_transition('y');
      this._layer.actor.set_child_above_sibling(card.actor, null);
      this._decorations.get(card.entry.id)?.badge.hide();
    });
    pan.connect('pan-update', () => {
      if (!start)
        return;
      const point = pan.get_centroid_abs();
      card.actor.set_position(start.x + point.x - start.px, start.y + point.y - start.py);
      const cell = target();
      this.showPlaceholder(card.entry.size, cell, this._layer.isFree(card.entry.size, cell, card.entry.id));
    });
    pan.connect('end', () => {
      if (!start)
        return;
      start = null;
      if (!stillLive()) {
        this.hidePlaceholder();
        return;
      }
      this._drop(card, () => this._layer.moveWidget(card.entry.id, target()));
    });
    pan.connect('cancel', () => {
      if (!start)
        return;
      start = null;
      if (!stillLive()) {
        this.hidePlaceholder();
        return;
      }
      this._drop(card, () => this._layer.relayout());
    });
    return pan;
  }

  // Applies the layout change (which puts the card at its final cell), then animates the card
  // there from wherever it was dropped.
  private _drop(card: DeskCard, apply: () => void): void {
    this.hidePlaceholder();
    // Defends the same case as `stillLive()` above for callers that reach `_drop` directly
    // (e.g. a stale gesture callback queued before the card was destroyed).
    if (this._layer.cards.get(card.entry.id) !== card)
      return;
    const from = { x: card.actor.x, y: card.actor.y };
    apply();
    const to = { x: card.actor.x, y: card.actor.y };
    card.actor.set_position(from.x, from.y);
    card.actor.ease({
      x: to.x,
      y: to.y,
      duration: SETTLE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._sync(),
    });
  }

  private _paintDots(): void {
    if (!this._dots)
      return;
    const cr = this._dots.get_context();
    const geo = this._layer.geometry;
    cr.setSourceColor(this._dots.get_theme_node().get_foreground_color());
    for (let row = 0; row <= geo.rows; row++) {
      for (let col = 0; col <= geo.cols; col++) {
        const { x, y } = cellToPoint(geo, { col, row });
        cr.arc(x - geo.gap / 2, y - geo.gap / 2, 1.5, 0, 2 * Math.PI);
        cr.fill();
      }
    }
    cr.$dispose();
  }
}
