import Clutter from 'gi://Clutter';
import St from 'gi://St';
import type { CalendarView } from '../../core/calendar-view.ts';
import type { CalendarService } from '../../services/calendar.ts';
import { CalendarPopup } from '../../shell/calendar-popup.ts';
import { hitsControl } from './calendar-input.ts';

export interface CalendarPopupControllerOptions {
  box: St.Widget;
  service: CalendarService;
  birthdays: boolean;
  ready: () => boolean;
  view: () => CalendarView;
  use24h: () => boolean;
  // Runs once the popup closes (from any cause - Esc, an outside click, the top-bar menu
  // opening, or destroy()): the caller re-asserts its own browse and re-renders.
  onClosed: () => void;
}

// Wires the widget's click-to-open-popup gesture and owns the
// CalendarPopup's lifetime, so calendar.ts itself only holds this one field instead of the
// popup, the gesture and the open flag. The popup is built lazily, on the first real open.
export class CalendarPopupController {
  private readonly _box: St.Widget;
  private readonly _opts: CalendarPopupControllerOptions;
  private readonly _click: Clutter.ClickGesture;
  private _popup: CalendarPopup | null = null;
  private _open = false;
  // Set at the start of destroy(), before this._popup.destroy() runs close() -> the popup's own
  // 'open-state-changed' handler -> onClosed below. Without this, destroying the widget while its
  // popup is open would still run onClosed's browse()/render() calls against a scope that's
  // already (or about to be) disposed.
  private _destroying = false;

  constructor(opts: CalendarPopupControllerOptions) {
    this._box = opts.box;
    this._opts = opts;
    // Recognizes on release (recognize_on_press left unset), so a press that turns into a drag
    // or a scroll elsewhere never opens the popup - only a genuine click does.
    this._click = new Clutter.ClickGesture({ required_button: Clutter.BUTTON_PRIMARY });
    this._click.connect('recognize', () => {
      const point = this._click.get_coords_abs();
      const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, point.x, point.y);
      if (hitsControl(hit, this._box) || !this._opts.ready())
        return;
      this._openPopup();
    });
    this._box.add_action(this._click);
  }

  // Just an open/visible flag - true from _openPopup() until the popup fully closes (any cause).
  // Not itself a browse-ownership check: calendar.ts's _render() reads it only to decide whether
  // losing its own browse should still return to today (isOpen false) or instead wait, showing an
  // empty grid, for the popup to close or reclaim the browse itself (isOpen true) - see
  // CalendarPopup._render()'s own reclaim/fallback logic for the latter.
  get isOpen(): boolean {
    return this._open;
  }

  destroy(): void {
    this._destroying = true;
    this._box.remove_action(this._click);
    this._popup?.destroy();
    this._popup = null;
  }

  private _openPopup(): void {
    this._popup ??= new CalendarPopup(this._box, this._opts.service, {
      birthdays: this._opts.birthdays,
      onClosed: () => {
        this._open = false;
        // Skip while destroy() is tearing this down: the widget's own onClosed browses and
        // renders, which must not run against a scope that's already disposed (or being disposed
        // this same call, since destroy() calls _popup.destroy() -> close() -> this, before the
        // widget's own cleanups after it have necessarily finished).
        if (!this._destroying)
          this._opts.onClosed();
      },
    });
    this._open = true;
    this._popup.open(this._opts.view(), this._opts.use24h());
  }
}
