import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import type { SizeName } from '../core/grid.ts';
import type { ServiceHub } from '../services/hub.ts';
import type { WidgetConfig } from '../widgets/base.ts';
import type { DeskCard } from './desk-card.ts';
import type { DeskLayer } from './desk-layer.ts';
import type { EditMode } from './edit-mode.ts';
import { backgroundManagers, backgroundMenuOf, type BackgroundManagerLike } from './shell-private.ts';

const SIZE_NAMES: Record<SizeName, string> = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra Large' };

// Adds "Edit Widgets…" to the Shell's desktop right-click menu. Each background manager
// recreates its actor and menu on 'changed' (wallpaper change), and monitors-changed recreates
// the managers, so the item is re-added in both cases.
export class DesktopMenuHook {
  private readonly _onEdit: () => void;
  // Every manager we've called connectObject('changed', ...) on, whether or not it had a menu to
  // hook at the time: tracked separately from `_added` so one whose menu was still null (e.g.
  // during startup) is still disconnected in destroy()/_hookAll(), instead of being silently
  // re-connected on the next monitors-changed and left with a duplicate 'changed' listener.
  private readonly _connected = new Set<BackgroundManagerLike>();
  private readonly _added = new Map<BackgroundManagerLike, { menu: PopupMenu.PopupMenu; items: PopupMenu.PopupBaseMenuItem[] }>();

  constructor(onEdit: () => void) {
    this._onEdit = onEdit;
    Main.layoutManager.connectObject('monitors-changed', () => this._hookAll(), this);
    this._hookAll();
  }

  destroy(): void {
    Main.layoutManager.disconnectObject(this);
    for (const manager of this._connected)
      manager.disconnectObject(this);
    for (const [manager, { menu, items }] of this._added) {
      if (backgroundMenuOf(manager) === menu)
        items.forEach(item => item.destroy());
    }
    this._connected.clear();
    this._added.clear();
  }

  private _hookAll(): void {
    for (const manager of this._connected)
      manager.disconnectObject(this);
    this._connected.clear();
    this._added.clear();
    for (const manager of backgroundManagers()) {
      manager.connectObject('changed', () => this._hook(manager), this);
      this._connected.add(manager);
      this._hook(manager);
    }
  }

  private _hook(manager: BackgroundManagerLike): void {
    const menu = backgroundMenuOf(manager);
    if (!menu || this._added.get(manager)?.menu === menu)
      return;
    const item = new PopupMenu.PopupMenuItem('Edit Widgets…');
    item.connect('activate', () => this._onEdit());
    const separator = new PopupMenu.PopupSeparatorMenuItem();
    menu.addMenuItem(separator, 0);
    menu.addMenuItem(item, 0);
    this._added.set(manager, { menu, items: [item, separator] });
  }
}

// Right-click menu on each widget: size, the widget's own options, Edit Widgets…, Remove.
export class WidgetMenus {
  private readonly _layer: DeskLayer;
  private readonly _editMode: EditMode;
  private readonly _hub: ServiceHub;
  private readonly _menu: PopupMenu.PopupMenu;
  private readonly _manager: PopupMenu.PopupMenuManager;
  private readonly _hooked = new WeakSet<DeskCard>();
  private readonly _unsubscribeLayer: () => void;

  constructor(layer: DeskLayer, editMode: EditMode, hub: ServiceHub) {
    this._layer = layer;
    this._editMode = editMode;
    this._hub = hub;
    this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
    this._menu.actor.add_style_class_name('background-menu');
    Main.layoutManager.uiGroup.add_child(this._menu.actor);
    this._menu.actor.hide();
    this._manager = new PopupMenu.PopupMenuManager(layer.actor);
    this._manager.addMenu(this._menu);
    this._unsubscribeLayer = layer.onChanged(() => this._hookCards());
    this._hookCards();
  }

  destroy(): void {
    this._unsubscribeLayer();
    this._menu.destroy();
  }

  // Card actions die with their cards, so only new cards need hooking.
  private _hookCards(): void {
    for (const card of this._layer.cards.values()) {
      if (this._hooked.has(card))
        continue;
      const click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true });
      click.connect('recognize', () => {
        if (this._editMode.active)
          return;
        const point = click.get_coords_abs();
        this._open(card, point.x, point.y);
      });
      card.actor.add_action(click);
      this._hooked.add(card);
    }
  }

  private _open(card: DeskCard, x: number, y: number): void {
    const { def } = card;
    const id = card.entry.id;
    const config = { ...def.defaultConfig, ...card.entry.config };
    this._menu.removeAll();

    // Reads the card's raw stored config as of activation time, not whatever was captured when
    // the menu was opened: another activation on this same open menu (or the card being removed)
    // between then and now must not resurrect a stale patch built on top of an outdated base.
    // Looked up through the layer's live map (not `card.entry.config` directly) so a removed
    // card - gone from `this._layer.cards` even though the local `card` reference is still a
    // valid, if now-stale, object - is detected and skipped rather than silently reviving it.
    const currentConfig = (): WidgetConfig | null => this._layer.cards.get(id)?.entry.config ?? null;

    for (const size of def.sizes) {
      const item = new PopupMenu.PopupMenuItem(SIZE_NAMES[size]);
      item.setOrnament(size === card.entry.size ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
      item.sensitive = size === card.entry.size || this._layer.canResize(id, size);
      item.connect('activate', () => {
        if (size !== card.entry.size)
          this._layer.resizeWidget(id, size);
      });
      this._menu.addMenuItem(item);
    }

    for (const option of def.options) {
      if (option.kind === 'action') {
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(option.label, () => def.runAction?.(option.key, this._hub));
      } else if (option.kind === 'toggle') {
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const item = new PopupMenu.PopupSwitchMenuItem(option.label, config[option.key] === true);
        item.connect('toggled', (_item, state: boolean) => {
          const live = currentConfig();
          if (live)
            this._layer.setConfig(id, { ...live, [option.key]: state });
        });
        this._menu.addMenuItem(item);
      } else {
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(option.label));
        for (const choice of option.choices) {
          const item = new PopupMenu.PopupMenuItem(choice.label);
          item.setOrnament(config[option.key] === choice.value ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
          item.connect('activate', () => {
            const live = currentConfig();
            if (live)
              this._layer.setConfig(id, { ...live, [option.key]: choice.value });
          });
          this._menu.addMenuItem(item);
        }
      }
    }

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    this._menu.addAction('Edit Widgets…', () => this._editMode.enter());
    this._menu.addAction('Remove Widget', () => this._layer.removeWidget(id));

    Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
    this._menu.open(BoxPointer.PopupAnimation.FULL);
  }
}
