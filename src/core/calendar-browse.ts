// The calendar service's browse/hold state machine: who currently owns browsing another month, and the bounded hold that keeps a today-view widget from flashing "No
// events" for the gap between a browse ending and the shared event source's real reload landing
// (see HOLD_TIMEOUT_MS in services/calendar.ts and admitRead() below for why). Pure and gi-free - unit-tested under Node - driven only through the injected
// Scheduler (services/service.ts, itself gi-free) for the fallback timer.
import type { Scheduler } from '../services/service.ts';

export interface CalendarBrowseTarget {
  readonly owner: object;
  readonly month: Date; // always the first of the browsed month
}

// What CalendarService.browse()'s caller must actually do, decided purely from the current browse
// state:
// - 'none': ownership arbitration rejected the request (ending someone else's browse, or a
//   same-owner/same-month no-op); nothing changed.
// - 'start': point the Shell calendar at `month` and emit (a new or changed browse).
// - 'end': a browse this owner held just ended; run the normal refresh. The hold is already armed.
export type BrowseRequestResult =
  | { kind: 'none' }
  | { kind: 'start'; month: Date }
  | { kind: 'end' };

export class CalendarBrowseState {
  private readonly _scheduler: Scheduler;
  private readonly _holdTimeoutMs: number;
  private readonly _onHoldExpired: () => void;
  private _owner: object | null = null;
  private _month: Date | null = null;
  private _hold = false;
  private _holdTimer: number | null = null;

  // `onHoldExpired` runs once the fallback timer fires with the hold still up (see _armHold's own
  // comment) - the caller re-emits so a calendar with genuinely no events today eventually gets a
  // published snapshot again instead of sitting on the held one forever.
  constructor(scheduler: Scheduler, holdTimeoutMs: number, onHoldExpired: () => void) {
    this._scheduler = scheduler;
    this._holdTimeoutMs = holdTimeoutMs;
    this._onHoldExpired = onHoldExpired;
  }

  // The active browse, if any. Read-only for the caller: CalendarService reads `.month` (for
  // monthGridRange()) and `.owner` (for its own ownership checks) but never mutates through this.
  get target(): CalendarBrowseTarget | null {
    return this._owner !== null && this._month !== null ? { owner: this._owner, month: this._month } : null;
  }

  get holding(): boolean {
    return this._hold;
  }

  // One browsing view at a time: a new owner's browse replaces the previous owner's.
  // `endsBrowse` folds together "no month at all" and "the browsed month equals the current one"
  // - the caller has already reduced
  // both to that one flag, so this stays gi-free and doesn't need calendar-view.ts's sameMonth.
  // Ending someone else's browse (an owner mismatch) is a no-op either way.
  request(owner: object, month: Date | null, endsBrowse: boolean): BrowseRequestResult {
    if (endsBrowse) {
      if (this._owner !== owner)
        return { kind: 'none' };
      this._owner = null;
      this._month = null;
      this._armHold();
      return { kind: 'end' };
    }
    const first = month!; // endsBrowse is false only when the caller passed a real month
    if (this._owner === owner && this._month !== null && this._month.getTime() === first.getTime())
      return { kind: 'none' };
    this._owner = owner;
    this._month = first;
    return { kind: 'start', month: first };
  }

  // Midnight ends every browse outright, regardless of who owns it - the hold applies
  // just as it would for an owner-initiated end. Returns whether a browse was actually active.
  endForMidnight(): boolean {
    if (this._owner === null)
      return false;
    this._owner = null;
    this._month = null;
    this._armHold();
    return true;
  }

  // stop(): drop everything with no hold armed - there is nobody left to read a later snapshot.
  clear(): void {
    this._owner = null;
    this._month = null;
    this._clearHold();
  }

  // The today-cache hold's gate: whether a read (`sameRange`: over the same range the cache
  // already describes; `nonEmpty`: whether it actually found events) should replace the stored
  // cache, and the "clear-on-non-empty" rule alongside it. A still-empty read over the *same*
  // range is the shared source's own synchronous reset echo, not real data yet, and must not
  // stomp the cache with it while the hold is up; a different range means the old cache doesn't
  // even describe the right grid any more and is replaced regardless of the hold; a non-empty
  // read is always the real thing, is always admitted, and always ends the hold outright.
  admitRead(sameRange: boolean, nonEmpty: boolean): boolean {
    if (this._hold && nonEmpty)
      this._clearHold();
    return !this._hold || !sameRange || nonEmpty;
  }

  // Bounded release for a hold: if nothing has cleared it within holdTimeoutMs, force it open (via
  // onHoldExpired) so the caller publishes whatever a fresh read actually gives, including a
  // legitimate "no events today" - a calendar with no events today, or no calendars at all, never
  // produces a non-empty read to clear the hold on its own otherwise. Re-arming (a second end in
  // quick succession) restarts the window rather than stacking timers; still one pending at most.
  private _armHold(): void {
    this._hold = true;
    if (this._holdTimer !== null)
      this._scheduler.cancel(this._holdTimer);
    this._holdTimer = this._scheduler.schedule(this._holdTimeoutMs, () => {
      this._holdTimer = null;
      if (this._hold) {
        this._hold = false;
        this._onHoldExpired();
      }
    });
  }

  private _clearHold(): void {
    this._hold = false;
    if (this._holdTimer !== null) {
      this._scheduler.cancel(this._holdTimer);
      this._holdTimer = null;
    }
  }
}
