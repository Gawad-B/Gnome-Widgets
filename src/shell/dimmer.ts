import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { isDimMode, shouldDim } from '../core/dim.ts';
import { dimLook } from '../core/theme-math.ts';
import type { Theme } from './theme.ts';

const EFFECT = 'desk-dim';
const DURATION_MS = 300;

// Dims the widget layer while a normal window has focus on the primary monitor, like macOS.
export class Dimmer {
  private readonly _actor: Clutter.Actor;
  private readonly _settings: Gio.Settings;
  private readonly _theme: Theme;
  private readonly _effect = new Clutter.DesaturateEffect({ factor: 0 });
  private readonly _unsubscribeTheme: () => void;
  private _focus: Meta.Window | null = null;
  private _editing = false;
  private _targetOpacity: number | null = null;
  private _targetFactor: number | null = null;

  constructor(actor: Clutter.Actor, settings: Gio.Settings, theme: Theme) {
    this._actor = actor;
    this._settings = settings;
    this._theme = theme;
    actor.add_effect_with_name(EFFECT, this._effect);

    global.display.connectObject(
      'notify::focus-window', () => this._trackFocus(),
      // A window can change monitor without a focus change (drag, keybinding, DnD in the
      // overview); only react when it's the one we're tracking.
      'window-entered-monitor', (_d: Meta.Display, _index: number, win: Meta.Window) => {
        if (win === this._focus)
          this._update();
      },
      'window-left-monitor', (_d: Meta.Display, _index: number, win: Meta.Window) => {
        if (win === this._focus)
          this._update();
      },
      this);
    global.workspace_manager.connectObject('active-workspace-changed', () => this._update(), this);
    settings.connectObject('changed::dim-mode', () => this._update(), this);
    // primaryIndex can change (monitor unplugged/replugged, primary reassigned).
    Main.layoutManager.connectObject('monitors-changed', () => this._update(), this);
    this._unsubscribeTheme = theme.onChanged(() => this._update());
    this._trackFocus();
  }

  setEditing(editing: boolean): void {
    this._editing = editing;
    this._update();
  }

  destroy(): void {
    global.display.disconnectObject(this);
    global.workspace_manager.disconnectObject(this);
    Main.layoutManager.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._focus?.disconnectObject(this);
    this._focus = null;
    this._unsubscribeTheme();
    this._actor.remove_all_transitions();
    this._actor.remove_effect(this._effect);
    this._actor.opacity = 255;
    this._targetOpacity = null;
    this._targetFactor = null;
  }

  private _trackFocus(): void {
    this._focus?.disconnectObject(this);
    this._focus = global.display.focus_window;
    this._focus?.connectObject(
      'notify::minimized', () => this._update(),
      // A window can change workspace without losing focus (window menu, drag in the
      // overview, Super+Shift+Arrow).
      'workspace-changed', () => this._update(),
      'unmanaged', () => {
        this._focus?.disconnectObject(this);
        this._focus = null;
        this._update();
      },
      this);
    this._update();
  }

  private _covered(): boolean {
    const w = this._focus;
    return w !== null &&
      w.get_window_type() === Meta.WindowType.NORMAL &&
      !w.minimized &&
      w.located_on_workspace(global.workspace_manager.get_active_workspace()) &&
      w.get_monitor() === Main.layoutManager.primaryIndex;
  }

  private _update(): void {
    const mode = this._settings.get_string('dim-mode');
    const dim = shouldDim(isDimMode(mode) ? mode : 'automatic', this._covered(), this._editing);
    const look = dimLook(this._theme.state.translucency);
    const opacity = dim ? look.opacity : 255;
    const factor = dim && look.desaturate ? 0.8 : 0;
    // Skip re-triggering both eases when the targets haven't changed: several of the signals
    // above (workspace-changed, monitors-changed, theme changes, ...) can fire without the
    // dimmed/undimmed outcome actually changing, and restarting an in-flight ease from its
    // current value causes a visible stutter mid-fade.
    if (opacity === this._targetOpacity && factor === this._targetFactor)
      return;
    this._targetOpacity = opacity;
    this._targetFactor = factor;
    const params = { duration: DURATION_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD };
    this._actor.ease({ opacity, ...params });
    this._actor.ease_property(`@effects.${EFFECT}.factor`, factor, params);
  }
}
