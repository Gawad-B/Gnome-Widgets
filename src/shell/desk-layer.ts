import type Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
  autoPlace, cellToPoint, clampToGrid, computeGeometry, isFree as gridIsFree, resizeTarget, spanPixels,
  type Cell, type Geometry, type Placement, type SizeName,
} from '../core/grid.ts';
import {
  defaultLayout, newId, parseLayout, serializeLayout, splitKnown, type Layout, type WidgetEntry,
} from '../core/layout.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { WidgetConfig, WidgetDefinition } from '../widgets/base.ts';
import { DeskCard } from './desk-card.ts';
import { backgroundGroup } from './shell-private.ts';
import type { Theme, ThemeState } from './theme.ts';

// The widget layer: one actor over the primary monitor's work area holding a DeskCard per
// layout entry. It is the only code that reads or writes the persisted layout.
export class DeskLayer {
  readonly actor: St.Widget;
  private readonly _settings: Gio.Settings;
  private readonly _registry: ReadonlyMap<string, WidgetDefinition>;
  private readonly _hub: ServiceHub;
  private readonly _theme: Theme;
  private readonly _cards = new Map<string, DeskCard>();
  private readonly _listeners = new Set<() => void>();
  private readonly _unsubscribeTheme: () => void;
  private _layout: Layout;
  private _positions = new Map<string, Cell>();
  private _geometry: Geometry = computeGeometry(0, 0, 16);
  private _lastSaved = '';

  constructor(
    settings: Gio.Settings, registry: ReadonlyMap<string, WidgetDefinition>, hub: ServiceHub, theme: Theme,
  ) {
    this._settings = settings;
    this._registry = registry;
    this._hub = hub;
    this._theme = theme;
    // Not reactive: clicks on empty desktop fall through to the wallpaper (and its menu).
    this.actor = new St.Widget({ name: 'desk-widgets-layer', reactive: false });
    backgroundGroup().add_child(this.actor);

    this._layout = this._load();
    this._unsubscribeTheme = theme.onChanged(state => this._applyTheme(state));
    settings.connectObject(
      'changed::layout', () => this._onLayoutSetting(),
      'changed::grid-gap', () => this.relayout(),
      this);
    global.display.connectObject('workareas-changed', () => this.relayout(), this);
    Main.layoutManager.connectObject('monitors-changed', () => this.relayout(), this);

    this._rebuildCards();
    this._applyTheme(theme.state);
  }

  get geometry(): Geometry {
    return this._geometry;
  }

  get cards(): ReadonlyMap<string, DeskCard> {
    return this._cards;
  }

  // Visible placements after clamping to the current grid.
  placements(): Placement[] {
    const result: Placement[] = [];
    for (const [id, cell] of this._positions) {
      const card = this._cards.get(id);
      if (card)
        result.push({ id, size: card.entry.size, col: cell.col, row: cell.row });
    }
    return result;
  }

  // Called after every relayout: cards added, removed, moved or resized, or the grid changed.
  onChanged(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // Recomputes the grid from the primary work area and positions every card. Clamped positions
  // are not persisted, so a temporarily smaller screen doesn't rewrite the saved layout.
  relayout(): void {
    const primary = Main.layoutManager.primaryIndex;
    if (primary < 0)
      return;
    const area = Main.layoutManager.getWorkAreaForMonitor(primary);
    this.actor.set_position(area.x, area.y);
    this.actor.set_size(area.width, area.height);
    this._geometry = computeGeometry(area.width, area.height, this._settings.get_int('grid-gap'));

    const wanted = this._layout.widgets
      .filter(w => this._cards.has(w.id))
      .map(({ id, size, col, row }) => ({ id, size, col, row }));
    const { placed } = clampToGrid(this._geometry, wanted);
    this._positions = new Map(placed.map(p => [p.id, { col: p.col, row: p.row }]));

    for (const [id, card] of this._cards) {
      const cell = this._positions.get(id);
      card.actor.visible = cell !== undefined;
      if (!cell)
        continue;
      const { x, y } = cellToPoint(this._geometry, cell);
      const { width, height } = spanPixels(this._geometry, card.entry.size);
      card.actor.set_position(x, y);
      card.actor.set_size(width, height);
    }
    for (const listener of [...this._listeners])
      listener();
  }

  isFree(size: SizeName, cell: Cell, ignoreId?: string): boolean {
    return gridIsFree(this._geometry, this.placements(), size, cell, ignoreId);
  }

  // Adds a widget at `cell`, or at the first free cell when omitted. Null when there's no room.
  addWidget(type: string, size: SizeName, cell?: Cell): string | null {
    const def = this._registry.get(type);
    if (!def || !def.sizes.includes(size))
      return null;
    const target = cell ?? autoPlace(this._geometry, this.placements(), size);
    if (!target || !this.isFree(size, target))
      return null;
    const id = newId(new Set(this._layout.widgets.map(w => w.id)));
    const entry: WidgetEntry = { id, type, size, col: target.col, row: target.row, config: {} };
    this._layout = { ...this._layout, widgets: [...this._layout.widgets, entry] };
    this._addCard(entry);
    this._save();
    this.relayout();
    return id;
  }

  // Moves a widget if the target is free. Relayouts either way, so an invalid drop snaps back.
  moveWidget(id: string, cell: Cell): boolean {
    const card = this._cards.get(id);
    const valid = card !== undefined && this.isFree(card.entry.size, cell, id);
    if (valid) {
      this._updateEntry(id, { col: cell.col, row: cell.row });
      this._save();
    }
    this.relayout();
    return valid;
  }

  removeWidget(id: string): void {
    this._layout = { ...this._layout, widgets: this._layout.widgets.filter(w => w.id !== id) };
    // Remove from `_cards` before destroying: destroying a card can synchronously cancel an
    // in-progress drag on it (see EditMode), whose handler checks `_cards.get(id) === card` to
    // tell a live card from one being torn down. Destroying first would leave that check
    // passing during the card's own destruction.
    const card = this._cards.get(id);
    this._cards.delete(id);
    card?.destroy();
    this._save();
    this.relayout();
  }

  canResize(id: string, size: SizeName): boolean {
    const card = this._cards.get(id);
    return card !== undefined && card.def.sizes.includes(size) &&
      resizeTarget(this._geometry, this.placements(), id, size) !== null;
  }

  // Resizes in place when it fits, otherwise moves to the nearest cell where it does.
  resizeWidget(id: string, size: SizeName): boolean {
    const card = this._cards.get(id);
    if (!card || !card.def.sizes.includes(size))
      return false;
    const cell = resizeTarget(this._geometry, this.placements(), id, size);
    if (!cell)
      return false;
    this._updateEntry(id, { size, col: cell.col, row: cell.row });
    this._save();
    this.relayout();
    return true;
  }

  setConfig(id: string, config: WidgetConfig): void {
    if (this._updateEntry(id, { config }))
      this._save();
  }

  // Edit mode lifts the layer above windows; restore() puts it back under them.
  reparent(parent: Clutter.Actor): void {
    this.actor.get_parent()?.remove_child(this.actor);
    parent.add_child(this.actor);
  }

  restore(): void {
    this.reparent(backgroundGroup());
  }

  destroy(): void {
    this._unsubscribeTheme();
    this._settings.disconnectObject(this);
    global.display.disconnectObject(this);
    Main.layoutManager.disconnectObject(this);
    // See removeWidget()'s comment: clear `_cards` before destroying, not after.
    const cards = [...this._cards.values()];
    this._cards.clear();
    for (const card of cards)
      card.destroy();
    this._listeners.clear();
    this.actor.destroy();
  }

  // Replaces one entry in the layout and hands it to its card (rebuilding the widget if its
  // size or config changed). Does not save or relayout.
  private _updateEntry(id: string, patch: Partial<Omit<WidgetEntry, 'id' | 'type'>>): WidgetEntry | null {
    const index = this._layout.widgets.findIndex(w => w.id === id);
    const current = this._layout.widgets[index];
    if (index === -1 || !current)
      return null;
    const updated: WidgetEntry = { ...current, ...patch };
    const widgets = [...this._layout.widgets];
    widgets[index] = updated;
    this._layout = { ...this._layout, widgets };
    this._cards.get(id)?.update(updated);
    return updated;
  }

  private _load(): Layout {
    const raw = this._settings.get_string('layout');
    const parsed = parseLayout(raw);
    if (parsed.ok) {
      // So a later external write of an earlier value we saved isn't mistaken for our own
      // write and ignored: _lastSaved must track what's actually in the setting now, not
      // just what we last wrote ourselves.
      this._lastSaved = raw;
      return parsed.layout;
    }
    if (parsed.reason === 'invalid') {
      console.error(`Desk Widgets: layout setting is unreadable (${parsed.error}); saved it to layout-backup and reset`);
      this._settings.set_string('layout-backup', raw);
    }
    const layout = defaultLayout(new Set(this._registry.keys()));
    this._save(layout);
    return layout;
  }

  private _save(layout: Layout = this._layout): void {
    this._lastSaved = serializeLayout(layout);
    this._settings.set_string('layout', this._lastSaved);
  }

  // Ignores our own writes; anything else (prefs "Reset layout", dconf edits) reloads.
  private _onLayoutSetting(): void {
    if (this._settings.get_string('layout') === this._lastSaved)
      return;
    this._layout = this._load();
    this._rebuildCards();
  }

  private _rebuildCards(): void {
    // See removeWidget()'s comment: clear `_cards` before destroying, not after.
    const cards = [...this._cards.values()];
    this._cards.clear();
    for (const card of cards)
      card.destroy();
    for (const entry of splitKnown(this._layout, new Set(this._registry.keys())).known)
      this._addCard(entry);
    this.relayout();
  }

  private _addCard(entry: WidgetEntry): DeskCard {
    const def = this._registry.get(entry.type);
    if (!def)
      throw new Error(`unknown widget type ${entry.type}`);
    const card = new DeskCard(entry, def, this._hub);
    card.applyTheme(this._theme.state);
    this.actor.add_child(card.actor);
    this._cards.set(entry.id, card);
    return card;
  }

  private _applyTheme(state: ThemeState): void {
    this.actor.remove_style_class_name(state.mode === 'dark' ? 'desk-light' : 'desk-dark');
    this.actor.add_style_class_name(state.mode === 'dark' ? 'desk-dark' : 'desk-light');
    for (const card of this._cards.values())
      card.applyTheme(state);
  }
}
