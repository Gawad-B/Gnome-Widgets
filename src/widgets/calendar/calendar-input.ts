import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

// One view step per scroll notch; smooth (touchpad) deltas accumulate to a full notch first.
// Up/left steps back (-1), down/right steps forward (+1).
export class ScrollStepper {
  private _acc = 0;

  step(event: Clutter.Event): number {
    // A real wheel click delivers a genuine discrete UP/DOWN event *and* an emulated SMOOTH
    // ±1.0 event (and a touchpad's real SMOOTH deltas come with an emulated discrete event) -
    // both from the same physical notch. Counting both would double every step, which is
    // exactly what ui/slider.js:153 avoids by dropping the emulated one; do the same here.
    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
      return 0;
    switch (event.get_scroll_direction()) {
    case Clutter.ScrollDirection.UP:
    case Clutter.ScrollDirection.LEFT:
      return -1;
    case Clutter.ScrollDirection.DOWN:
    case Clutter.ScrollDirection.RIGHT:
      return 1;
    case Clutter.ScrollDirection.SMOOTH: {
      const [dx, dy] = event.get_scroll_delta();
      this._acc += Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (Math.abs(this._acc) < 1)
        return 0;
      const n = Math.sign(this._acc);
      this._acc = 0;
      return n;
    }
    default:
      return 0;
    }
  }
}

// Fires once `ms` after the last poke(); owns at most one tracked GLib source, removed by
// cancel() (called from poke() itself, and from the widget's own scope cleanup).
export class IdleReturn {
  private readonly _ms: number;
  private readonly _fire: () => void;
  private _id = 0;

  constructor(ms: number, fire: () => void) {
    this._ms = ms;
    this._fire = fire;
  }

  poke(): void {
    this.cancel();
    this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._ms, () => {
      this._id = 0;
      this._fire();
      return GLib.SOURCE_REMOVE;
    });
  }

  cancel(): void {
    if (this._id !== 0) {
      GLib.source_remove(this._id);
      this._id = 0;
    }
  }
}

// True when a click at `actor` landed on a control (any St.Button - the arrows, day cells and
// Today pill) inside `root`. Used to keep the widget's click-to-open-popup gesture from firing on
// top of a control's own click.
export function hitsControl(actor: Clutter.Actor | null, root: Clutter.Actor): boolean {
  for (let a = actor; a && a !== root; a = a.get_parent()) {
    if (a instanceof St.Button)
      return true;
  }
  return false;
}
