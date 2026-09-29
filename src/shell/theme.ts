import Gio from 'gi://Gio';
import { cardStyle, glassCardCss, type CardStyle, type ColorMode } from '../core/theme-math.ts';

export interface ThemeState {
  mode: ColorMode;
  translucency: number;
  glass: boolean;
  card: CardStyle;
  // The card's inline style while glass is on (see glassCardCss); `card.css` above is still
  // computed regardless, since `card.outlineTracks` and the plain-card fallback both need it.
  glassCss: string;
}

// Resolves light/dark and the card surface from settings, and tells listeners when either
// changes. The accent color needs no code: the stylesheet uses -st-accent-color.
export class Theme {
  private readonly _settings: Gio.Settings;
  private readonly _interface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
  private readonly _listeners = new Set<(state: ThemeState) => void>();
  private _state: ThemeState;

  constructor(settings: Gio.Settings) {
    this._settings = settings;
    this._state = this._compute();
    this._interface.connectObject('changed::color-scheme', () => this._refresh(), this);
    settings.connectObject(
      'changed::theme-mode', () => this._refresh(),
      'changed::translucency', () => this._refresh(),
      'changed::glass', () => this._refresh(),
      this);
  }

  get state(): ThemeState {
    return this._state;
  }

  onChanged(listener: (state: ThemeState) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._interface.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._listeners.clear();
  }

  private _compute(): ThemeState {
    const preference = this._settings.get_string('theme-mode');
    const mode: ColorMode = preference === 'light' || preference === 'dark'
      ? preference
      : this._interface.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
    const translucency = this._settings.get_int('translucency');
    const glass = this._settings.get_boolean('glass');
    return { mode, translucency, glass, card: cardStyle(mode, translucency), glassCss: glassCardCss(mode, translucency) };
  }

  private _refresh(): void {
    this._state = this._compute();
    for (const listener of [...this._listeners])
      listener(this._state);
  }
}
