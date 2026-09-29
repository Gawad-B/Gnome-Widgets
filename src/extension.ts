import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ServiceHub } from './services/hub.ts';
import { DesktopMenuHook, WidgetMenus } from './shell/context-menu.ts';
import { DeskLayer } from './shell/desk-layer.ts';
import { Dimmer } from './shell/dimmer.ts';
import { EditMode } from './shell/edit-mode.ts';
import { Gallery } from './shell/gallery.ts';
import { shellStartingUp } from './shell/shell-private.ts';
import { Theme } from './shell/theme.ts';
import { WorkspaceSwitchClones } from './shell/workspace-switch.ts';
import { REGISTRY } from './widgets/registry.ts';

export default class DeskWidgetsExtension extends Extension {
  private _hub: ServiceHub | null = null;
  private _theme: Theme | null = null;
  private _layer: DeskLayer | null = null;
  private _workspaceSwitch: WorkspaceSwitchClones | null = null;
  private _dimmer: Dimmer | null = null;
  private _editMode: EditMode | null = null;
  private _gallery: Gallery | null = null;
  private _desktopMenu: DesktopMenuHook | null = null;
  private _widgetMenus: WidgetMenus | null = null;

  enable(): void {
    // The layer needs the primary monitor's work area, which only exists after startup.
    if (shellStartingUp()) {
      Main.layoutManager.connectObject('startup-complete', () => {
        Main.layoutManager.disconnectObject(this);
        this._build();
      }, this);
    } else {
      this._build();
    }
  }

  disable(): void {
    // Each step runs even if an earlier one throws (e.g. a half-constructed `_build()`, or a
    // Shell API misbehaving), so one broken piece never strands the others — and every field is
    // nulled regardless of whether its teardown succeeded, so disable() never leaves behind a
    // reference enable() (or a rebuild after a caught _build() failure) might reuse or re-destroy.
    const safely = (fn: () => void): void => {
      try {
        fn();
      } catch (e) {
        console.error('Desk Widgets: teardown step failed', e);
      }
    };
    safely(() => Main.wm.removeKeybinding('edit-shortcut'));
    safely(() => this._widgetMenus?.destroy());
    safely(() => this._desktopMenu?.destroy());
    this._widgetMenus = null;
    this._desktopMenu = null;
    safely(() => Main.layoutManager.disconnectObject(this));
    safely(() => this._gallery?.destroy());
    this._gallery = null;
    safely(() => this._editMode?.destroy());
    this._editMode = null;
    safely(() => this._dimmer?.destroy());
    this._dimmer = null;
    safely(() => this._workspaceSwitch?.destroy());
    this._workspaceSwitch = null;
    safely(() => this._layer?.destroy());
    safely(() => this._theme?.destroy());
    safely(() => this._hub?.destroy());
    this._layer = null;
    this._theme = null;
    this._hub = null;
  }

  private _build(): void {
    try {
      const settings = this.getSettings();
      this._hub = new ServiceHub();
      this._theme = new Theme(settings);
      this._layer = new DeskLayer(settings, REGISTRY, this._hub, this._theme);
      this._workspaceSwitch = new WorkspaceSwitchClones(this._layer.actor);
      this._dimmer = new Dimmer(this._layer.actor, settings, this._theme);
      this._editMode = new EditMode(this._layer, this._dimmer);
      this._gallery = new Gallery({
        layer: this._layer, editMode: this._editMode, registry: REGISTRY, hub: this._hub, theme: this._theme,
      });
      this._desktopMenu = new DesktopMenuHook(() => this._editMode?.enter());
      this._widgetMenus = new WidgetMenus(this._layer, this._editMode, this._hub);
      const action = Main.wm.addKeybinding('edit-shortcut', settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL, () => this._editMode?.toggle());
      this._editMode.setToggleAction(action);
    } catch (e) {
      // A partially-built extension (e.g. the layer constructed but the keybinding failing)
      // must not stay half up: tear down whatever did get built, via the same disable() path
      // used on a normal unload, then propagate so the extension system marks us ERROR instead
      // of silently running in a broken state.
      this.disable();
      throw e;
    }
  }
}
